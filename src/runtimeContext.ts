/**
 * runtimeContext.ts - per-agent execution context.
 *
 * Claude Code gives sub-agents their own execution context instead of relying
 * on process-global cwd. This is the small version: every agent run can carry
 * its own project root and cwd, while old call sites still fall back to the
 * current global project root.
 */

import type { WorktreeSession } from './worktrees.js'
import { getOriginalProjectRoot, getProjectRoot } from './workingDirectory.js'

export interface AgentRuntimeContext {
  agentId?: string
  /** Stable root for resolving relative tool paths and enforcing cwd bounds. */
  projectRoot: string
  /** Current working directory for this agent. Defaults to projectRoot. */
  cwd: string
  /** Original root for the parent session; useful when a worktree is active. */
  originalProjectRoot: string
  worktreeSession?: WorktreeSession | null
}

export function createAgentRuntimeContext(input: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext {
  const projectRoot = input.projectRoot ?? getProjectRoot()
  return {
    agentId: input.agentId,
    projectRoot,
    cwd: input.cwd ?? projectRoot,
    originalProjectRoot: input.originalProjectRoot ?? getOriginalProjectRoot(),
    worktreeSession: input.worktreeSession ?? null,
  }
}
