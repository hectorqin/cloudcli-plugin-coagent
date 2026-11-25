import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export type MergeResult = { ok: true; commit: string } | { ok: false; reason: string; conflicts: string[] };

export const Git = {
  async repoRoot(cwd: string): Promise<string | null> {
    try { return await git(cwd, 'rev-parse', '--show-toplevel'); } catch { return null; }
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

  /** Merges `branch` into whatever the lead has checked out. Aborts cleanly on conflict. */
  async merge(leadCwd: string, branch: string, message: string): Promise<MergeResult> {
    if (await git(leadCwd, 'status', '--porcelain', '--untracked-files=no')) {
      return { ok: false, reason: 'the lead working tree has uncommitted changes to tracked files', conflicts: [] };
    }
    try {
      await git(leadCwd, '-c', 'user.name=coagent', '-c', 'user.email=coagent@localhost', 'merge', '--no-ff', '-m', message, branch);
      return { ok: true, commit: await git(leadCwd, 'rev-parse', 'HEAD') };
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
    await git(path.dirname(common), 'worktree', 'remove', '--force', worktreePath);
  },
};

export type GitOps = typeof Git;
