/** Types for scripts/e2e-cleanup.mjs (so the strict typecheck covers its tests). */
export interface CleanupAgent {
  id?: string;
  provider?: string;
  cwd?: string;
  appSessionId?: string | null;
  providerSessionId?: string | null;
  worktreePath?: string | null;
}
export interface CleanupBroker {
  runs(): Promise<{ id: string; projectPath: string; status: string }[]>;
  detail(runId: string): Promise<{ run: { status: string }; agents: CleanupAgent[] } | null>;
  endRun(runId: string): Promise<{ ok?: boolean; failedWorktrees?: { agentId: string; path: string; reason?: string; error?: string }[] }>;
}
export interface CleanupResult {
  ok: boolean;
  endedRuns: string[];
  rows: Record<string, number>;
  removed: string[];
  kept: string[];
  problems: string[];
  manual: string[];
}
export function isInside(root: string, candidate: string): boolean;
export function safeExisting(root: string, candidate: string): string | null;
export function claudeProjectDirName(projectPath: string): string;
export function assertCleanupRoot(tempRoot: string, tmpDir?: string): void;
export function cleanupTempRoot(opts: {
  tempRoot: string;
  tmpDir?: string;
  dbPath: string;
  claudeRoot: string;
  codexRoot: string;
  broker: CleanupBroker;
  sessionStatus: (id: string) => Promise<boolean | null>;
  captured?: CleanupAgent[];
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: runs between planning and deleting. */
  beforeDelete?: () => void | Promise<void>;
}): Promise<CleanupResult>;
