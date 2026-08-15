export type ClientOrigin = 'shortcut' | 'web' | 'mac' | 'ide' | 'routine'
export type ClientRunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
export type ClientApprovalChoice = 'allow_once' | 'allow_for_session' | 'reject_once'

export interface ClientProject {
  name: string
  path: string
  lastUsedAt: string
  source: 'agentRoot' | 'manual' | 'selected'
}

export interface ClientWorkspaceMetadata {
  id: string
  kind: 'scratch' | 'project' | 'existing'
  path: string
  displayName: string
}

export interface ClientSessionMetadata {
  origin?: ClientOrigin
  executionRoot?: string
  workspace?: ClientWorkspaceMetadata
}

export interface ClientSessionSummary {
  id: string
  title: string
  lastUserMessage: string | null
  metadata?: ClientSessionMetadata
}

export interface ClientRunSnapshot {
  id: string
  sessionId: string
  workspaceRoot: string
  executionRoot: string
  status: ClientRunStatus
  createdAt: string
  updatedAt: string
  finishedAt?: string
  error?: string
}

export interface ClientApprovalRequest {
  id: string
  toolName: string
  title: string
  detail: string
  args?: Record<string, unknown>
  files?: string[]
  diff?: string
  previewError?: string
}

export type ClientRunOutput =
  | { type: 'approval_request'; request: ClientApprovalRequest }
  | { type: 'approval_response'; id: string; choice: ClientApprovalChoice }
  | { type: 'done'; sessionId?: string; messageCount?: number; cancelled?: boolean }
  | { type: 'error'; error: string }
  | { type: string; [key: string]: unknown }

export interface ClientRunEnvelope {
  cursor: number
  run: ClientRunSnapshot
  output?: ClientRunOutput
}

export interface ClientProtocolFixture {
  project: ClientProject
  session: ClientSessionSummary
  run: ClientRunSnapshot
  envelope: ClientRunEnvelope
}

export function assertClientProtocolFixture(value: unknown): asserts value is ClientProtocolFixture {
  const fixture = record(value, 'fixture')
  const project = record(fixture.project, 'project')
  string(project.name, 'project.name')
  string(project.path, 'project.path')
  string(project.lastUsedAt, 'project.lastUsedAt')
  oneOf(project.source, ['agentRoot', 'manual', 'selected'], 'project.source')

  const session = record(fixture.session, 'session')
  string(session.id, 'session.id')
  string(session.title, 'session.title')
  if (session.lastUserMessage !== null) string(session.lastUserMessage, 'session.lastUserMessage')

  assertRun(fixture.run, 'run')
  const envelope = record(fixture.envelope, 'envelope')
  if (!Number.isSafeInteger(envelope.cursor) || Number(envelope.cursor) < 0) throw new Error('envelope.cursor must be a non-negative integer')
  assertRun(envelope.run, 'envelope.run')
}

function assertRun(value: unknown, label: string): void {
  const run = record(value, label)
  for (const key of ['id', 'sessionId', 'workspaceRoot', 'executionRoot', 'createdAt', 'updatedAt'] as const) {
    string(run[key], `${label}.${key}`)
  }
  oneOf(run.status, ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'], `${label}.status`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`)
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): asserts value is T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`${label} is invalid`)
}
