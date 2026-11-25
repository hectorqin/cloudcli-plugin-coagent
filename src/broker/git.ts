import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MergeSnapshotData, MergeSnapshotFile } from '../shared/protocol.js';

const exec = promisify(execFile);
export const MAX_UNIFIED_DIFF_BYTES = 200 * 1024;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

function limitedUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/** Runs git while retaining at most maxBytes + one truncation sentinel byte. */
async function boundedGit(cwd: string, maxBytes: number, ...args: string[]): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (kept < maxBytes + 1) {
        const part = chunk.subarray(0, maxBytes + 1 - kept);
        chunks.push(part);
        kept += part.length;
      }
      if (kept > maxBytes) { truncated = true; child.kill(); }
    });
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !truncated) return reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `git exited ${code}`));
      const limited = limitedUtf8(Buffer.concat(chunks).toString('utf8'), maxBytes);
      resolve({ text: limited.text.trim(), truncated: truncated || limited.truncated });
    });
  });
}

function nulTokens(raw: string): string[] {
  const out = raw.split('\0');
  if (out.at(-1) === '') out.pop();
  return out;
}

function snapshotFiles(nameStatus: string, numstat: string): MergeSnapshotFile[] {
  const countTokens = nulTokens(numstat);
  const counts: { additions: number | null; deletions: number | null; binary: boolean }[] = [];
  for (let i = 0; i < countTokens.length;) {
    const header = countTokens[i++];
    const [a, d, filePath] = header.split('\t');
    counts.push({ additions: a === '-' ? null : Number(a), deletions: d === '-' ? null : Number(d), binary: a === '-' || d === '-' });
    // With -z, a rename has an empty path in the header followed by old and new path tokens.
    if (filePath === '') i += 2;
  }
  const files: MergeSnapshotFile[] = [];
  const names = nulTokens(nameStatus);
  for (let i = 0; i < names.length;) {
    const status = names[i++];
    const renamed = status.startsWith('R') || status.startsWith('C');
    const oldPath = renamed ? names[i++] : null;
    const filePath = names[i++];
    files.push({ path: filePath, oldPath, status, ...(counts[files.length] ?? { additions: 0, deletions: 0, binary: false }) });
  }
  return files;
}

export type MergeResult = { ok: true; commit: string; actualBase: string; baseMoved: boolean }
  | { ok: false; reason: string; conflicts: string[] };

export const Git = {
  async repoRoot(cwd: string): Promise<string | null> {
    try { return await git(cwd, 'rev-parse', '--show-toplevel'); } catch { return null; }
  },

  async resolve(cwd: string, ref: string): Promise<string> { return git(cwd, 'rev-parse', ref); },

  async head(cwd: string): Promise<string> { return Git.resolve(cwd, 'HEAD'); },

  async status(cwd: string): Promise<string> { return git(cwd, 'status', '--porcelain'); },

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    try { await git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant); return true; } catch { return false; }
  },

  /** Canonical identity shared by every worktree of a repository. */
  async commonDir(cwd: string): Promise<string> {
    const common = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    return fs.promises.realpath(common);
  },

  async mergeSnapshot(leadCwd: string, workerCwd: string, workerRef = 'HEAD'): Promise<MergeSnapshotData> {
    const workerHead = await Git.resolve(workerCwd, workerRef);
    const leadHead = await Git.head(leadCwd);
    const mergeBase = await git(leadCwd, 'merge-base', leadHead, workerHead);
    const range = `${mergeBase}..${workerHead}`;
    const [stat, rawNameStatus, numstat, fullDiff] = await Promise.all([
      git(workerCwd, 'diff', '--stat', range),
      git(workerCwd, 'diff', '--name-status', '-z', '--find-renames', range),
      git(workerCwd, 'diff', '--numstat', '-z', '--find-renames', range),
      boundedGit(workerCwd, MAX_UNIFIED_DIFF_BYTES, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', range),
    ]);
    const files = snapshotFiles(rawNameStatus, numstat);
    const nameStatus = files.map((f) => `${f.status}\t${f.oldPath ? `${f.oldPath}\t` : ''}${f.path}`).join('\n');
    return { workerHead, leadHead, mergeBase, stat, nameStatus, files, diff: fullDiff.text, diffTruncated: fullDiff.truncated };
  },

  /**
   * Creates `<repo>-worktrees/coagent-<runId>-<agentId>` on a new branch `coagent/<runId>/<agentId>` from the lead's
   * HEAD (the same container directory CloudCLI uses for its own worktrees). Run-scoped names never collide across
   * runs. On failure nothing is left behind.
   */
  async createWorktree(leadCwd: string, runId: string, agentId: string): Promise<{ worktreePath: string; branch: string }> {
    const root = await Git.repoRoot(leadCwd);
    if (!root) throw new Error(`${leadCwd} is not inside a git repository; writing agents need one for worktrees`);
    const container = path.join(path.dirname(root), `${path.basename(root)}-worktrees`);
    fs.mkdirSync(container, { recursive: true });
    const worktreePath = path.join(container, `coagent-${runId}-${agentId}`);
    const branch = `coagent/${runId}/${agentId}`;
    if (fs.existsSync(worktreePath)) throw new Error(`${worktreePath} already exists`);
    if (await git(root, 'branch', '--list', branch)) throw new Error(`branch ${branch} already exists`);
    try {
      await git(root, 'worktree', 'add', '-b', branch, worktreePath, 'HEAD');
    } catch (e) {
      await Git.discardWorktree(root, worktreePath, branch);
      throw e;
    }
    return { worktreePath, branch };
  },

  /** Best-effort removal of a worktree and its branch that never held any work (spawn compensation). */
  async discardWorktree(repoCwd: string, worktreePath: string, branch: string): Promise<void> {
    await git(repoCwd, 'worktree', 'remove', '--force', worktreePath).catch(() => undefined);
    fs.rmSync(worktreePath, { recursive: true, force: true });
    await git(repoCwd, 'worktree', 'prune').catch(() => undefined);
    await git(repoCwd, 'branch', '-D', branch).catch(() => undefined);
  },

  /** Commits anything the agent left uncommitted, so the merge sees all of its work. */
  async commitAll(worktreePath: string, message: string): Promise<boolean> {
    if (!(await git(worktreePath, 'status', '--porcelain'))) return false;
    await git(worktreePath, 'add', '-A');
    await git(worktreePath, '-c', 'user.name=coagent', '-c', 'user.email=coagent@localhost', 'commit', '-q', '-m', message);
    return true;
  },

  /** Merges an exact commit into whatever the lead has checked out. Aborts cleanly on conflict. */
  async merge(leadCwd: string, commit: string, message: string, expectedHead: string): Promise<MergeResult> {
    if (await git(leadCwd, 'status', '--porcelain', '--untracked-files=no')) {
      return { ok: false, reason: 'the lead working tree has uncommitted changes to tracked files', conflicts: [] };
    }
    try {
      await git(leadCwd, '-c', 'user.name=coagent', '-c', 'user.email=coagent@localhost', 'merge', '--no-ff', '-m', message, commit);
      const merged = await Git.head(leadCwd);
      const actualBase = await Git.resolve(leadCwd, `${merged}^1`);
      return { ok: true, commit: merged, actualBase, baseMoved: actualBase !== expectedHead };
    } catch (e) {
      const conflicts = (await git(leadCwd, 'diff', '--name-only', '--diff-filter=U').catch(() => '')).split('\n').filter(Boolean);
      await git(leadCwd, 'merge', '--abort').catch(() => undefined);
      return { ok: false, reason: conflicts.length ? 'merge conflict' : (e as Error).message.split('\n')[0], conflicts };
    }
  },

  async removeWorktree(worktreePath: string): Promise<void> {
    const root = await Git.repoRoot(worktreePath);
    if (!root) return;
    const common = await git(worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    await git(path.dirname(common), 'worktree', 'remove', worktreePath);
  },
};

export type GitOps = typeof Git;
