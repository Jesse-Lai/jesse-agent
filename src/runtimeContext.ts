/**
 * runtimeContext.ts - per-agent execution context.
 *
 * Claude Code gives sub-agents their own execution context instead of relying
 * on process-global cwd. This is the small version: every agent run can carry
 * its own project root and cwd, while old call sites still fall back to the
 * current global project root.
 */

import type { ToolApprovalHandler } from './toolApprovals.js'
import type { WorktreeEventInput, WorktreeSession } from './worktrees.js'
import { getOriginalProjectRoot, getProjectRoot } from './workingDirectory.js'
import { getPermissionMode, type PermissionMode } from './permissionMode.js'
import type { PermissionRule } from './permissions.js'

export interface RuntimeFileChange {
  path: string
  action: 'created' | 'updated' | 'edited'
  changedAt: string
}

export interface RuntimeCommandResult {
  label: string
  ok: boolean
  finishedAt: string
}

export interface AgentRuntimeContext {
  agentId?: string
  /** Session/run identity used to keep mutable runtime state scoped. */
  sessionId?: string
  /** Stable root for resolving relative tool paths and enforcing cwd bounds. */
  projectRoot: string
  /** Current working directory for this agent. Defaults to projectRoot. */
  cwd: string
  /** Original root for the parent session; useful when a worktree is active. */
  originalProjectRoot: string
  worktreeSession?: WorktreeSession | null
  /** Permission mode and remembered rules belong to this run/session, not the process. */
  permissionMode: PermissionMode
  permissionRules: PermissionRule[]
  /** Run-local cancellation, including long image-generation tool calls. */
  signal?: AbortSignal
  approvalHandler?: ToolApprovalHandler
  onWorktreeEvent?: (event: WorktreeEventInput) => Promise<void> | void
  /** Optional run-local observers used by durable product activity summaries. */
  onFileChange?: (change: RuntimeFileChange) => void
  onVerification?: (result: RuntimeCommandResult) => void
}

export function createAgentRuntimeContext(input: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext {
  const projectRoot = input.projectRoot ?? getProjectRoot()
  return {
    agentId: input.agentId,
    sessionId: input.sessionId,
    projectRoot,
    cwd: input.cwd ?? projectRoot,
    originalProjectRoot: input.originalProjectRoot ?? getOriginalProjectRoot(),
    worktreeSession: input.worktreeSession ?? null,
    permissionMode: input.permissionMode ?? getPermissionMode(),
    permissionRules: input.permissionRules ?? [],
    signal: input.signal,
    approvalHandler: input.approvalHandler,
    onWorktreeEvent: input.onWorktreeEvent,
    onFileChange: input.onFileChange,
    onVerification: input.onVerification,
  }
}
