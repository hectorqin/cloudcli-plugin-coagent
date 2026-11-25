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
   * Creates `<repo>-worktrees/coagent-<agentId>` on a new branch `coagent/<agentId>` from the lead's HEAD.
   * Same container directory CloudCLI uses for its own worktrees.
   */
  async createWorktree(leadCwd: string, agentId: string): Promise<{ worktreePath: string; branch: string }> {
    const root = await Git.repoRoot(leadCwd);
    if (!root) throw new Error(`${leadCwd} is not inside a git repository; writing agents need one for worktrees`);
    const container = path.join(path.dirname(root), `${path.basename(root)}-worktrees`);
    fs.mkdirSync(container, { recursive: true });
    const worktreePath = path.join(container, `coagent-${agentId}`);
    const branch = `coagent/${agentId}`;
    await git(root, 'worktree', 'add', '-b', branch, worktreePath, 'HEAD');
    return { worktreePath, branch };
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
