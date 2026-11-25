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
  | 'end_agent'
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
  gate?: { id: number; kind: GateKind; title: string; body: string; snapshot?: MergeSnapshot | null };
}

export type RunStatus = 'active' | 'ended';
export type PlanStatus = 'none' | 'pending' | 'approved' | 'rejected';
/** `interrupted`: the broker restarted while this worker had a turn open; the lead decides whether to continue or end it. */
export type AgentStatus = 'lead' | 'starting' | 'running' | 'idle' | 'reported' | 'merged' | 'error' | 'ended' | 'interrupted';
/**
 * Delivery state of a message. queued → dispatching (a turn carrying it was sent, under a lease) → delivered;
 * a 409 or an error before CloudCLI accepted the turn puts it back to queued. `cancelled`: its recipient was
 * ended or merged before it could be delivered. Messages handed over inside a tool result (read_inbox, waits) go straight
 * from queued to delivered.
 */
export type DeliveryState = 'queued' | 'dispatching' | 'delivered' | 'cancelled';
export type GateKind = 'plan' | 'merge';
export type GateStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface MergeSnapshotFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** Immutable review material captured when a merge gate is opened. */
export interface MergeSnapshot {
  workerHead: string;
  leadHead: string;
  mergeBase: string;
  files: MergeSnapshotFile[];
  diffTruncated: boolean;
}

/** Stored by the broker, but never included in the ordinary state/tool payloads. */
export interface MergeSnapshotData extends MergeSnapshot {
  stat: string;
  nameStatus: string;
  diff: string;
}

export interface RunDTO {
  id: string;
  leadAgentId: string;
  projectPath: string;
  status: RunStatus;
  planStatus: PlanStatus;
  createdAt: string;
  /** Totals over every turn the broker ran in this run (lead and workers). */
  usage: RunUsageDTO;
}

/**
 * How a turn ended. Rows exist only for turns CloudCLI accepted: a 409 (busy) or an error before acceptance never
 * started a turn and writes none. `aborted`: the user stopped it in CloudCLI. `interrupted`: the broker restarted while it
 * was open. null = still running.
 */
export type TurnOutcome = 'ok' | 'error' | 'aborted' | 'interrupted';

/**
 * Usage of the turns the broker ran for one agent (turns the user drives in the UI are not seen). null = unknown.
 * Token sums only include turns whose usage is a per-turn bill (Codex); Claude reports context snapshots, which are
 * never summed (see src/broker/usage.ts).
 */
export interface AgentUsageDTO {
  turns: number;
  /** Duration of finished turns plus the elapsed time of the running one. */
  totalMs: number | null;
  /** Elapsed time of the turn running now, null when none is. */
  currentTurnMs: number | null;
  /** Context-window occupancy at the latest snapshot, and the window it is measured against. */
  lastContextTokens: number | null;
  contextWindow: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface RunUsageDTO {
  turns: number;
  totalMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
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
  usage: AgentUsageDTO;
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
  state: DeliveryState;
  /** How many turns were started to deliver it (a value > 1 means it was retried). */
  attempts: number;
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
  snapshot: MergeSnapshot | null;
}

export type EventType =
  | 'run_started' | 'run_ended' | 'spawned' | 'turn_start' | 'turn_end' | 'gate_opened' | 'gate_decided' | 'merge'
  | 'wait_start' | 'wait_end' | 'recovered' | 'agent_ended';

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
  setup: { apiKeyConfigured: boolean; registration: Record<string, string>; autoRegister: boolean };
  /** Agent id of the session the user is currently viewing, if it belongs to a run. */
  me: string | null;
  current: RunDetailDTO | null;
  runs: (RunDTO & { agentCount: number; pendingGates: number })[];
}
