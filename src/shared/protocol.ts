/** Wire types shared by the broker, the MCP shim and the tab UI. */

export type Provider = 'claude' | 'codex';
export const SUPPORTED_PROVIDERS: readonly Provider[] = ['claude', 'codex'];

export type ToolName =
  | 'submit_plan'
  | 'spawn_agent'
  | 'send_message'
  | 'read_inbox'
  | 'report_result'
  | 'request_merge'
  | 'list_agents'
  | 'wait_for_agents'
  // Internal: used by the shim while a lead's tool call blocks on a gate, never exposed to models.
  | 'gate_wait'
  | 'gate_decide';

/** Who is calling a coagent tool, as observed by the MCP shim (not self-reported). */
export interface Caller {
  provider: Provider | null;
  /** Provider-native session id: CLAUDE_CODE_SESSION_ID or Codex `_meta` thread_id. */
  providerSessionId: string | null;
  cwd: string | null;
}

export interface ToolRequest {
  tool: ToolName;
  args: Record<string, unknown>;
  caller: Caller;
}

export interface ToolResponse {
  ok: boolean;
  /** Text returned to the model as the tool result. */
  text: string;
  /** The call is still waiting (wait_for_agents / gate_wait): the shim polls again. */
  pending?: boolean;
  /** Short status for MCP progress notifications while pending. */
  progress?: string;
  /** A gate was opened; the shim may ask the user inline (MCP elicitation) instead of returning `text`. */
  gate?: { id: number; kind: GateKind; title: string; body: string };
}

export type RunStatus = 'active' | 'ended';
export type PlanStatus = 'none' | 'pending' | 'approved' | 'rejected';
export type AgentStatus = 'lead' | 'starting' | 'running' | 'idle' | 'reported' | 'merged' | 'error' | 'ended';
export type GateKind = 'plan' | 'merge';
export type GateStatus = 'pending' | 'approved' | 'rejected';

export interface RunDTO {
  id: string;
  leadAgentId: string;
  projectPath: string;
  status: RunStatus;
  planStatus: PlanStatus;
  createdAt: string;
}

export interface AgentDTO {
  id: string;
  runId: string;
  role: string;
  provider: Provider;
  providerSessionId: string | null;
  appSessionId: string | null;
  cwd: string;
  branch: string | null;
  worktreePath: string | null;
  status: AgentStatus;
  task: string | null;
  result: string | null;
  lastError: string | null;
  busy: boolean;
  /** Most recent things the agent did in turns the broker ran (newest last; in memory only). */
  activity: { ts: string; text: string }[];
}

export interface MessageDTO {
  id: number;
  runId: string;
  from: string | null;
  to: string;
  kind: 'message' | 'result' | 'gate' | 'system';
  body: string;
  createdAt: string;
  deliveredAt: string | null;
}

export interface GateDTO {
  id: number;
  runId: string;
  kind: GateKind;
  requestedBy: string;
  subjectAgent: string | null;
  payload: string;
  status: GateStatus;
  comment: string | null;
  createdAt: string;
}

export type EventType =
  | 'run_started' | 'run_ended' | 'spawned' | 'turn_start' | 'turn_end' | 'gate_opened' | 'gate_decided' | 'merge'
  | 'wait_start' | 'wait_end';

/** Timeline facts that are not messages. `agentId` is the lane the event belongs to (null = the user). */
export interface EventDTO {
  id: number;
  runId: string;
  agentId: string | null;
  type: EventType;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface RunDetailDTO {
  run: RunDTO;
  agents: AgentDTO[];
  messages: MessageDTO[];
  gates: GateDTO[];
  events: EventDTO[];
}

/** Response of GET /state for the tab. */
export interface StateDTO {
  setup: { apiKeyConfigured: boolean; registration: Record<string, string> };
  /** Agent id of the session the user is currently viewing, if it belongs to a run. */
  me: string | null;
  current: RunDetailDTO | null;
  runs: (RunDTO & { agentCount: number; pendingGates: number })[];
}
