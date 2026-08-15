export type RoutineScheduleKind = 'manual' | 'daily' | 'weekly'

export interface RoutineSchedule {
  kind: RoutineScheduleKind
  time?: string
  timezone: string
  daysOfWeek?: number[]
}

export type RoutineConnectorKind = 'mcp' | 'http' | 'builtin' | 'manual'

export interface RoutineConnectorRef {
  id: string
  kind: RoutineConnectorKind
  displayName: string
  capabilities: string[]
  config: Record<string, string>
  enabled: boolean
}

export type RoutineWorkflowStepKind =
  | 'connector_fetch'
  | 'agent_prompt'
  | 'subagent_review'
  | 'audience_eval'
  | 'approval_gate'

export interface RoutineWorkflowStep {
  id: string
  kind: RoutineWorkflowStepKind
  title: string
  prompt: string
  connectorIds: string[]
  config: Record<string, string | number | boolean>
}

export type RoutineApprovalPolicy = 'read_only_auto' | 'ask_before_write' | 'ask_before_external_action'

export interface RoutineDefinition {
  id: string
  name: string
  description: string
  enabled: boolean
  schedule: RoutineSchedule
  scheduleText: string
  instruction: string
  workspaceRoot: string
  connectors: RoutineConnectorRef[]
  workflow: RoutineWorkflowStep[]
  approvalPolicy: RoutineApprovalPolicy
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  lastRunAt?: string
  nextRunAt?: string
}

export type RoutineRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'needs_approval'

export interface RoutineRunSummary {
  id: string
  routineId: string
  status: RoutineRunStatus
  startedAt: string
  finishedAt?: string
  sessionId?: string
  output: string
  error?: string
}

export interface RoutineTemplate {
  id: string
  name: string
  description: string
  schedule: RoutineSchedule
  scheduleText: string
  instruction: string
  connectors: RoutineConnectorRef[]
  workflow: RoutineWorkflowStep[]
  approvalPolicy: RoutineApprovalPolicy
}

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: 'morning-feedback-review',
    name: 'Morning Feedback Review',
    description: 'Summarize yesterday work feedback from any connected work sources, then propose implementation options in the selected workspace.',
    schedule: { kind: 'daily', time: '09:00', timezone: 'local' },
    scheduleText: 'Daily at 9:00',
    instruction:
      'Collect yesterday work-related feedback from connected sources, cluster it by theme and priority, then propose a few implementation options in the current workspace. Draft code changes only after approval.',
    connectors: [
      microsoftGraphConnector(),
      genericConnector('workspace-repo', 'Selected workspace', ['files.read', 'files.propose_changes']),
    ],
    workflow: [
      connectorFetchStep('fetch-feedback', 'Fetch work feedback', ['microsoft-graph'], 'Use the built-in Microsoft Graph tool to fetch yesterday work-related feedback from Teams chats and other enabled Microsoft 365 sources.'),
      agentPromptStep('summarize-feedback', 'Summarize and cluster feedback', 'Summarize feedback by source, stakeholder, theme, priority, and recommended action.'),
      agentPromptStep('propose-implementation', 'Propose implementation options', 'Inspect the selected workspace and propose 2-4 concrete implementation options that could address the feedback. Do not apply changes without approval.'),
      approvalGateStep('approve-code-work', 'Approval before writing', 'Ask before editing files or taking external actions.'),
    ],
    approvalPolicy: 'ask_before_write',
  },
  {
    id: 'daily-comedy-room',
    name: 'Daily Comedy Room',
    description: 'Combine yesterday web trends with connected notes, then iteratively improve a comedy draft through eval and audience-style subagents.',
    schedule: { kind: 'daily', time: '09:00', timezone: 'local' },
    scheduleText: 'Daily at 9:00',
    instruction:
      'Search yesterday hot topics, retrieve related material from connected knowledge sources, write a new comedy draft, evaluate it, then revise with audience-style review loops.',
    connectors: [
      genericConnector('web-trends', 'Web trend sources', ['web.search', 'news.search']),
      genericConnector('personal-material', 'Personal material sources', ['notes.search', 'documents.read']),
    ],
    workflow: [
      connectorFetchStep('fetch-trends', 'Fetch web trends', ['web-trends'], 'Find yesterday high-signal topics and news from enabled web/search connectors.'),
      connectorFetchStep('fetch-material', 'Fetch personal material', ['personal-material'], 'Retrieve related notes, bits, observations, and prior drafts from enabled knowledge connectors.'),
      agentPromptStep('draft-comedy', 'Draft comedy text', 'Create a new comedy draft that combines the trend material with personal material.'),
      audienceEvalStep('audience-eval', 'Audience evaluation', 'Run configurable audience-style subagent review, aggregate scores, and revise until threshold or max iterations.'),
    ],
    approvalPolicy: 'read_only_auto',
  },
]

export function defaultRoutineSchedule(): RoutineSchedule {
  return { kind: 'manual', timezone: 'local' }
}

function genericConnector(id: string, displayName: string, capabilities: string[]): RoutineConnectorRef {
  return { id, kind: 'manual', displayName, capabilities, config: {}, enabled: true }
}

function microsoftGraphConnector(): RoutineConnectorRef {
  return {
    id: 'microsoft-graph',
    kind: 'builtin',
    displayName: 'Microsoft Graph',
    capabilities: ['profile.read', 'teams.chats.read', 'teams.messages.read', 'graph.get'],
    config: { auth: 'chrome-outlook-local-token' },
    enabled: true,
  }
}

function connectorFetchStep(id: string, title: string, connectorIds: string[], prompt: string): RoutineWorkflowStep {
  return { id, kind: 'connector_fetch', title, prompt, connectorIds, config: {} }
}

function agentPromptStep(id: string, title: string, prompt: string): RoutineWorkflowStep {
  return { id, kind: 'agent_prompt', title, prompt, connectorIds: [], config: {} }
}

function approvalGateStep(id: string, title: string, prompt: string): RoutineWorkflowStep {
  return { id, kind: 'approval_gate', title, prompt, connectorIds: [], config: {} }
}

function audienceEvalStep(id: string, title: string, prompt: string): RoutineWorkflowStep {
  return {
    id,
    kind: 'audience_eval',
    title,
    prompt,
    connectorIds: [],
    config: { audienceCount: 100, batchSize: 10, maxIterations: 3, targetScore: 8 },
  }
}
