import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MergeSnapshotData, MergeSnapshotFile } from '../shared/protocol.js';

const exec = promisify(execFile);
export const MAX_UNIFIED_DIFF_BYTES = 200 * 1024;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** git with a private index file, so the worktree's real index (staged state) is never touched. */
async function gitWithIndex(cwd: string, indexFile: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  return stdout.trim();
}

/** The full content of a working tree, as git sees it, captured as a tree object. See Git.snapshotWorkingTree. */
export interface WorkingTreeSnapshot {
  /** The commit checked out there. */
  head: string;
  /** Tree of HEAD plus every tracked change, deletion and untracked (not ignored) file. Equals headTree when clean. */
  tree: string;
  headTree: string;
  /** Paths that differ from HEAD (modified, added, deleted, untracked). */
  changed: string[];
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
   * HEAD (the same container directory CloudCLI uses for its own worktrees), or from `startPoint` (a commit or ref, e.g.
   * the branch of a worker being handed off). Run-scoped names never collide across runs. On failure nothing is left
   * behind.
   */
  async createWorktree(leadCwd: string, runId: string, agentId: string, startPoint = 'HEAD'): Promise<{ worktreePath: string; branch: string }> {
    const root = await Git.repoRoot(leadCwd);
    if (!root) throw new Error(`${leadCwd} is not inside a git repository; writing agents need one for worktrees`);
    const container = path.join(path.dirname(root), `${path.basename(root)}-worktrees`);
    fs.mkdirSync(container, { recursive: true });
    const worktreePath = path.join(container, `coagent-${runId}-${agentId}`);
    const branch = `coagent/${runId}/${agentId}`;
    if (fs.existsSync(worktreePath)) throw new Error(`${worktreePath} already exists`);
    if (await git(root, 'branch', '--list', branch)) throw new Error(`branch ${branch} already exists`);
    try {
      // Resolved in the lead's checkout (HEAD there is the lead's HEAD, not the main checkout's).
      const start = await Git.resolve(leadCwd, `${startPoint}^{commit}`);
      await git(root, 'worktree', 'add', '-b', branch, worktreePath, start);
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

  /**
   * Captures everything in a working tree (tracked changes, staged or not, deletions, and untracked files that are not
   * ignored) as a git tree object, through a temporary copy of its index: the worktree, its index and its stash are left
   * exactly as they were. Ignored files (build output, node_modules, …) are not captured.
   */
  async snapshotWorkingTree(cwd: string): Promise<WorkingTreeSnapshot> {
    // A submodule's own changes live in its repository, not in this tree (only its gitlink would be captured), so a
    // snapshot with dirty submodules would silently miss work: refuse instead.
    const dirty = await Git.dirtySubmodules(cwd);
    if (dirty.length) {
      throw new Error(`submodule(s) with work that cannot be carried over: ${dirty.map((d) => `${d.path} (${d.issues.join(', ')})`).join('; ')}. `
        + 'Commit (and push) that work inside the submodule and record the submodule commit, or discard it, then retry');
    }
    const head = await Git.head(cwd);
    const headTree = await git(cwd, 'rev-parse', `${head}^{tree}`);
    const realIndex = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const tmpIndex = path.join(os.tmpdir(), `coagent-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    try {
      // Starting from a copy of the real index keeps git's stat cache, so unchanged files are not re-hashed.
      if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
      else await gitWithIndex(cwd, tmpIndex, 'read-tree', head);
      await gitWithIndex(cwd, tmpIndex, 'add', '-A', '--', '.');
      const tree = await gitWithIndex(cwd, tmpIndex, 'write-tree');
      const changed = tree === headTree ? [] : nulTokens(await git(cwd, 'diff-tree', '-r', '-z', '--no-renames', '--name-only', headTree, tree));
      return { head, tree, headTree, changed };
    } finally {
      fs.rmSync(tmpIndex, { force: true });
    }
  },

  /**
   * Submodules of a worktree whose content differs from what the superproject records: new commits checked out,
   * modified tracked files, or untracked files inside it (`git status --porcelain=v2` submodule flags; nested
   * submodules show up through their parent's flags).
   */
  async dirtySubmodules(cwd: string): Promise<{ path: string; issues: string[] }[]> {
    const tokens = nulTokens(await git(cwd, 'status', '--porcelain=v2', '-z', '--ignore-submodules=none', '--untracked-files=normal'));
    const out: { path: string; issues: string[] }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const kind = t[0];
      if (kind === '2') i++; // a rename/copy entry is followed by its original path
      if (kind !== '1' && kind !== '2') continue;
      const fields = t.split(' ');
      const sub = fields[2] ?? '';
      if (!sub.startsWith('S')) continue;
      const issues = [sub[1] === 'C' && 'new commits', sub[2] === 'M' && 'modified files', sub[3] === 'U' && 'untracked files']
        .filter((x): x is string => !!x);
      if (issues.length) out.push({ path: fields.slice(kind === '1' ? 8 : 9).join(' '), issues });
    }
    return out;
  },

  /**
   * Makes a fresh worktree (checked out at `snapshot.head`, no local changes) hold the snapshot's content as uncommitted
   * changes: modified/deleted files show as unstaged changes and new files as untracked, as in the original. Then
   * verifies it: the worktree's own snapshot must be the identical tree. Throws on any difference.
   */
  async restoreWorkingTree(cwd: string, snapshot: WorkingTreeSnapshot): Promise<void> {
    if (await Git.head(cwd) !== snapshot.head) throw new Error(`${cwd} is not checked out at ${snapshot.head.slice(0, 10)}`);
    if (await git(cwd, 'status', '--porcelain')) throw new Error(`${cwd} is not clean`);
    if (snapshot.tree !== snapshot.headTree) {
      await git(cwd, 'read-tree', '-m', '-u', snapshot.headTree, snapshot.tree); // index + files := snapshot
      await git(cwd, 'reset', '-q'); // index back to HEAD; the files keep the snapshot content
    }
    const check = await Git.snapshotWorkingTree(cwd);
    if (check.tree !== snapshot.tree) {
      throw new Error(`carried-over files differ from the original (tree ${check.tree.slice(0, 10)} != ${snapshot.tree.slice(0, 10)})`);
    }
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

  /**
   * Removes `worktreePath` only if it is still a linked worktree of `repoCwd`'s repository checked out on `branch`.
   * A stored path can be stale: the directory may since belong to another repository or run, so anything else is
   * refused (throws) and left alone. 'gone' = nothing is on disk any more (a stale registration is pruned).
   */
  async removeOwnedWorktree(repoCwd: string, worktreePath: string, branch: string): Promise<'removed' | 'gone'> {
    const entries = parseWorktreeList(await git(repoCwd, 'worktree', 'list', '--porcelain'));
    const target = canonical(worktreePath);
    const index = entries.findIndex((e) => canonical(e.path) === target);
    const exists = fs.existsSync(worktreePath);
    if (index < 0) {
      if (!exists) return 'gone';
      throw new Error(`${worktreePath} is not a worktree of ${repoCwd}; it was left in place`);
    }
    if (index === 0) throw new Error(`${worktreePath} is the main working tree of ${repoCwd}; it was left in place`);
    if (entries[index].branch !== branch) {
      throw new Error(`${worktreePath} is checked out on ${entries[index].branch ?? 'a detached HEAD'}, not ${branch}; it was left in place`);
    }
    if (!exists) { await git(repoCwd, 'worktree', 'prune'); return 'gone'; }
    await git(repoCwd, 'worktree', 'remove', worktreePath);
    return 'removed';
  },

  async removeWorktree(worktreePath: string): Promise<void> {
    const root = await Git.repoRoot(worktreePath);
    if (!root) return;
    const common = await git(worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    await git(path.dirname(common), 'worktree', 'remove', worktreePath);
  },

  /** Delete a local branch only when Git's own merged-branch safety check permits it. */
  async deleteBranch(cwd: string, branch: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await git(cwd, 'branch', '-d', branch);
      return { ok: true };
    } catch (e) {
      const failure = e as Error & { stderr?: string };
      const detail = failure.stderr?.trim() || failure.message;
      const reason = detail.split('\n').find((line) => line.trim())?.trim() ?? 'git branch -d failed';
      return { ok: false, reason };
    }
  },
};

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry { path: string; branch: string | null }

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    let wt: string | null = null;
    let branch: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    if (wt) out.push({ path: wt, branch });
  }
  return out;
}

function canonical(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export type GitOps = typeof Git;
