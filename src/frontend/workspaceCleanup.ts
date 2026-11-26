import type { AgentDTO, RunDetailDTO } from '../shared/protocol.js';

export type CleanupTarget = { kind: 'project' | 'session'; value: string };

/** Browser-side POSIX normalization; CloudCLI project paths are absolute filesystem paths. */
function normalizedPath(value: string): string {
  const absolute = value.startsWith('/');
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.');
}

/** Defense in depth before calling destructive host project APIs. */
export function safeWorkerProject(agent: AgentDTO, run: RunDetailDTO): string | null {
  if (agent.id === run.run.leadAgentId || !agent.branch
    || (run.run.status !== 'ended' && agent.status !== 'merged' && agent.status !== 'ended')) return null;
  const worker = normalizedPath(agent.cwd);
  const repo = normalizedPath(run.run.projectPath);
  const lead = normalizedPath(run.agents.find((a) => a.id === run.run.leadAgentId)?.cwd ?? run.run.projectPath);
  if (worker === repo || worker === lead) return null;
  const container = `${repo.replace(/\/$/, '')}-worktrees/`;
  return worker.startsWith(container) && worker.length > container.length ? worker : null;
}

export function safeWorkerSession(agent: AgentDTO, run: RunDetailDTO): string | null {
  if (agent.id === run.run.leadAgentId || agent.branch
    || (run.run.status !== 'ended' && !['reported', 'idle', 'ended'].includes(agent.status))) return null;
  const leadSession = run.agents.find((a) => a.id === run.run.leadAgentId)?.appSessionId;
  return agent.appSessionId && agent.appSessionId !== leadSession ? agent.appSessionId : null;
}

export function cleanupTarget(agent: AgentDTO, run: RunDetailDTO): CleanupTarget | null {
  const project = safeWorkerProject(agent, run);
  if (project) return { kind: 'project', value: project };
  const session = safeWorkerSession(agent, run);
  return session ? { kind: 'session', value: session } : null;
}

