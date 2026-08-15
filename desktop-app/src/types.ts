export interface DesktopProject {
  name: string
  path: string
  lastUsedAt: string
  source: 'agentRoot' | 'manual' | 'selected'
}

export interface QueuedComposerItem {
  id: string
  text: string
  mode: 'queue' | 'steer'
}

export interface DailyChangelogSummary {
  date: string
  projectName: string
  headline: string
  summary: string
  highlightCount: number
  illustrationStatus: 'pending' | 'generating' | 'ready' | 'failed'
  imageAvailable: boolean
  finalizedAt?: string
}

export interface DailyChangelogHighlight {
  title: string
  detail: string
}

export interface DailyChangelogDetail extends DailyChangelogSummary {
  highlights: DailyChangelogHighlight[]
  verification: string[]
  changedFiles: string[]
  sourceSessions: string[]
}

export interface DesktopRoutine {
  id: string
  name: string
  description: string
  scheduleText: string
  instruction: string
  workspaceRoot: string
  connectors: RoutineConnectorRef[]
  workflow: RoutineWorkflowStep[]
  approvalPolicy: 'read_only_auto' | 'ask_before_write' | 'ask_before_external_action'
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  lastRunAt?: string
  nextRunAt?: string
}

export interface RoutineConnectorRef {
  id: string
  kind: 'mcp' | 'http' | 'builtin' | 'manual'
  displayName: string
  capabilities: string[]
  config: Record<string, string>
  enabled: boolean
}

export interface RoutineWorkflowStep {
  id: string
  kind: 'connector_fetch' | 'agent_prompt' | 'subagent_review' | 'audience_eval' | 'approval_gate'
  title: string
  prompt: string
  connectorIds: string[]
  config: Record<string, string | number | boolean>
}

export interface RoutineTemplate {
  id: string
  name: string
  description: string
  scheduleText: string
  instruction: string
  connectors: RoutineConnectorRef[]
  workflow: RoutineWorkflowStep[]
  approvalPolicy: DesktopRoutine['approvalPolicy']
}

export interface RoutineRunSummary {
  id: string
  routineId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'needs_approval'
  startedAt: string
  finishedAt?: string
  sessionId?: string
  output: string
  error?: string
}

export interface SessionSummary {
  id: string
  title: string
  lastUserMessage: string | null
  pinned?: boolean
  metadata?: SessionMetadata
  lastRun?: SessionRunState | null
}

export interface SessionSourceContext {
  app?: string
  bundleIdentifier?: string
  url?: string
  title?: string
}

export interface SessionMetadata {
  origin?: 'shortcut' | 'web' | 'mac' | 'ide' | 'routine'
  source?: SessionSourceContext
  executionRoot?: string
  workspace?: SessionWorkspaceMetadata
}

export interface SessionWorkspaceMetadata {
  id: string
  kind: 'scratch' | 'project' | 'existing'
  path: string
  displayName: string
}

export type SessionRunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'

export interface SessionRunState {
  runId: string
  status: SessionRunStatus
  startedAt: string
  updatedAt: string
  finishedAt?: string
  error?: string
}

export interface AgentRunSnapshot {
  id: string
  sessionId: string
  workspaceRoot: string
  executionRoot: string
  status: SessionRunStatus
  source?: SessionSourceContext
  workspace?: SessionWorkspaceMetadata
  createdAt: string
  updatedAt: string
  finishedAt?: string
  error?: string
}

export interface AgentRunEnvelope {
  cursor: number
  run: AgentRunSnapshot
  output?: BridgeOutput
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
  attachments?: ImageAttachment[]
}

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

/**
 * A chat image can be inline while a turn is running, or URL-backed after the
 * Session has persisted it. Keeping both shapes in one UI type lets live and
 * restored conversations use the same renderer.
 */
export interface ImageAttachment {
  id?: string
  type: 'image'
  mimeType: ImageMimeType
  dataURL?: string
  assetId?: string
  url?: string
  name?: string
  byteLength?: number
  width?: number
  height?: number
  source?: 'user' | 'generated'
}

export interface ComposerImageAttachment extends ImageAttachment {
  id: string
  dataURL: string
  source: 'user'
}

export type ApprovalChoice = 'allow_once' | 'allow_for_session' | 'reject_once'

export interface ApprovalRequest {
  id: string
  toolName: string
  title: string
  detail: string
  args: Record<string, unknown>
  files?: string[]
  diff?: string
  previewError?: string
}

export interface PendingApproval {
  request: ApprovalRequest
  status: string
  disabled: boolean
  error?: string
}

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'assistant_attachment'; attachment: ImageAttachment }
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; content: string }
  | { type: 'error'; reason: string }
  | { type: 'max_turns' }

export type BridgeOutput =
  | { type: 'ready'; workspaceRoot?: string; cwd?: string; workspace?: SessionWorkspaceMetadata; sessionId?: string; permissionMode: string }
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_response'; id: string; choice: ApprovalChoice }
  | { type: 'done'; sessionId?: string; messageCount: number; cancelled?: boolean }
  | { type: 'error'; error: string }

export type ActivityKind = 'thinking' | 'read' | 'inspect' | 'edit' | 'command' | 'approval' | 'context' | 'done' | 'error'

export type ActivityStatus = 'pending' | 'running' | 'done' | 'error'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  label: string
  status: ActivityStatus
  summary?: string
  target?: string
  createdAt: string
  count?: number
}

export interface OutputFile {
  path: string
  action: string
  diff?: string
}

export interface CommandOutput {
  id: string
  command: string
  cwd: string
  ok: boolean
  content: string
}

export interface SourceItem {
  id: string
  kind: string
  label: string
  detail?: string
}

export interface ComposerAnnotation {
  id: string
  text: string
  label: string
  createdAt: string
}

export interface RunStep {
  id: string
  title: string
  status: 'pending' | 'active' | 'done' | 'error'
}

export type ConversationItem =
  | { id: string; type: 'message'; role: string; text: string; createdAt: string; attachments?: ImageAttachment[]; annotations?: ComposerAnnotation[]; canEdit?: boolean }
  | { id: string; type: 'activity'; items: ActivityItem[] }
  | { id: string; type: 'status'; tone: 'muted' | 'success' | 'warning' | 'error'; title: string; detail?: string }

export interface ToolInProgress {
  name: string
  args: Record<string, unknown>
}
