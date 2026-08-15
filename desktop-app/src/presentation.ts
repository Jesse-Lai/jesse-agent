import type { ActivityItem, ActivityKind, ActivityStatus, ApprovalChoice, ApprovalRequest } from './types'

export type ActivityDraft = Pick<ActivityItem, 'kind' | 'label'> & Partial<Pick<ActivityItem, 'status' | 'summary' | 'target'>>

export type ActivityFormatInput =
  | { type: 'tool_start'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; content?: string }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_response'; choice: ApprovalChoice }
  | { type: 'run_state'; kind: ActivityKind; label: string; status?: ActivityStatus; summary?: string; target?: string }

export function formatActivity(input: ActivityFormatInput): ActivityDraft {
  if (input.type === 'tool_start') {
    return {
      kind: toolActivityKind(input.name),
      label: toolActivityLabel(input.name),
      status: 'running',
    }
  }

  if (input.type === 'tool_result') {
    return {
      kind: toolActivityKind(input.name),
      label: toolActivityLabel(input.name),
      status: input.ok ? 'done' : 'error',
      summary: input.ok ? undefined : failedActivitySummary(input.name),
    }
  }

  if (input.type === 'approval_request') {
    return {
      kind: 'approval',
      label: 'Waiting for approval',
      status: 'pending',
      summary: summarizeApproval(input.request),
    }
  }

  if (input.type === 'approval_response') {
    return {
      kind: input.choice === 'reject_once' ? 'error' : 'approval',
      label: 'Approval resolved',
      status: input.choice === 'reject_once' ? 'error' : 'done',
      summary: labelChoice(input.choice),
    }
  }

  return {
    kind: input.kind,
    label: input.label,
    status: input.status ?? 'running',
    summary: input.summary,
    target: input.target,
  }
}

export function summarizeApproval(request: ApprovalRequest): string {
  if (request.files?.length) return request.files.join(', ')
  return request.title || request.toolName || 'Tool request'
}

export function approvalHeading(request: ApprovalRequest): string {
  if (request.toolName === 'write_file') return `Review file write: ${stringArg(request.args.path, 'unknown file')}`
  if (request.toolName === 'edit_file') return `Review file edit: ${stringArg(request.args.path, 'unknown file')}`
  if (request.toolName === 'run_command') {
    return `Approve shell command: ${stringArg(request.args.command, request.toolName)}`
  }
  if (request.toolName.startsWith('mcp__')) return `Approve external tool: ${request.toolName}`
  return request.title || 'Approval required'
}

export function approvalKind(request: ApprovalRequest): string {
  if (request.toolName === 'write_file' || request.toolName === 'edit_file') return 'File change'
  if (request.toolName === 'run_command' || request.toolName === 'run_background_command') return 'Shell command'
  if (request.toolName.startsWith('mcp__')) return 'External tool'
  return 'Tool action'
}

export function approvalSurface(request: ApprovalRequest): string {
  if (request.toolName === 'run_command' || request.toolName === 'run_background_command') return 'Terminal'
  if (request.toolName === 'write_file' || request.toolName === 'edit_file') return 'Files'
  if (request.toolName.startsWith('mcp__')) return 'External'
  return 'Tool'
}

export function approvalPromptText(request: ApprovalRequest): string {
  if (request.toolName === 'run_command') return 'Allow the agent to run this terminal command?'
  if (request.toolName === 'run_background_command') return 'Allow the agent to start this background command?'
  if (request.toolName === 'write_file') return `Allow the agent to write ${approvalTargetText(request)}?`
  if (request.toolName === 'edit_file') return `Allow the agent to edit ${approvalTargetText(request)}?`
  if (request.toolName.startsWith('mcp__')) return `Allow the agent to use ${request.toolName}?`
  return firstDetailLine(request) || request.title || 'Allow this tool action?'
}

export function approvalTargetText(request: ApprovalRequest): string {
  if (request.toolName === 'run_command' || request.toolName === 'run_background_command') {
    return stringArg(request.args.command, request.toolName)
  }
  if (request.files?.length) return request.files.join(', ')
  const path = stringArg(request.args.path)
  if (path) return path
  const action = stringArg(request.args.action)
  if (action) return action
  return request.toolName
}

export function approvalMeta(request: ApprovalRequest): string {
  if (request.files?.length) return `Files: ${request.files.join(', ')}`
  return `Tool: ${request.toolName}`
}

export function labelChoice(choice: ApprovalChoice): string {
  if (choice === 'allow_once') return 'Allow once'
  if (choice === 'allow_for_session') return 'Allow for session'
  return 'Reject'
}

export function stringArg(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value ? value : fallback
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function firstDetailLine(request: ApprovalRequest): string {
  return request.detail.split('\n').map(line => line.trim()).find(Boolean) || ''
}

function toolActivityKind(name: string): ActivityKind {
  if (name === 'read_file' || name === 'list_files' || name === 'glob_files') return 'read'
  if (name === 'grep_code') return 'inspect'
  if (name === 'write_file' || name === 'edit_file') return 'edit'
  if (name === 'run_command' || name === 'run_background_command') return 'command'
  if (name === 'use_skill' || name === 'microsoft_graph' || name.startsWith('mcp__')) return 'inspect'
  if (name === 'agent' || name.startsWith('task_')) return 'context'
  if (name.includes('image') || name.includes('screenshot')) return 'inspect'
  return 'inspect'
}

function toolActivityLabel(name: string): string {
  if (name === 'read_file') return 'Read files'
  if (name === 'list_files') return 'Listed files'
  if (name === 'glob_files') return 'Found files'
  if (name === 'grep_code') return 'Searched code'
  if (name === 'write_file' || name === 'edit_file') return 'Edited a file'
  if (name === 'run_command') return 'Ran a command'
  if (name === 'run_background_command') return 'Started a command'
  if (name === 'use_skill') return 'Loaded guidance'
  if (name === 'agent') return 'Asked another agent'
  if (name === 'task_list') return 'Checked tasks'
  if (name === 'task_output') return 'Read task output'
  if (name === 'task_continue') return 'Continued a task'
  if (name === 'task_stop') return 'Stopped a task'
  if (name === 'enter_worktree') return 'Created a worktree'
  if (name === 'exit_worktree') return 'Exited a worktree'
  if (name === 'microsoft_graph') return 'Checked Microsoft 365'
  if (name.startsWith('mcp__')) return 'Used a connector'
  if (name.includes('image') || name.includes('screenshot')) return 'Viewed an image'
  return 'Inspected context'
}

function failedActivitySummary(name: string): string {
  if (name === 'run_command' || name === 'run_background_command') return 'Command failed. Details are in the output.'
  return 'Action failed. Details are in the output.'
}
