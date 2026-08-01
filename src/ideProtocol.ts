/**
 * ideProtocol.ts - shared request/response helpers for IDE frontends.
 *
 * The one-shot stdio bridge and the long-lived local server use the same
 * protocol so editor clients do not fork the agent semantics.
 */

import { existsSync } from 'node:fs'
import type { ConfirmChoice } from './confirm.js'
import type { AgentEvent } from './loop.js'
import type { ToolApprovalRequest } from './toolApprovals.js'
import type { Message } from './llm.js'
import type { McpRuntimeContext } from './mcp.js'
import { loadProjectMemoryContext } from './memory.js'
import { loadSkillsContext } from './skills.js'
import { buildSystemPrompt } from './prompt.js'
import { getPlanModeContext } from './planMode.js'
import { parsePermissionMode, type PermissionMode } from './permissionMode.js'

export interface IdeBridgeRequest {
  prompt?: string
  messages?: IdeBridgeMessage[]
  context?: IdeBridgeContext
  permissionMode?: PermissionMode
  maxTurns?: number
}

export interface IdeBridgeMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface IdeBridgeContext {
  workspaceRoot?: string
  activeFile?: string
  activeFileLanguage?: string
  selectedText?: string
  diagnostics?: string
}

export interface IdeApprovalRequest extends ToolApprovalRequest {
  id: string
}

export type IdeBridgeOutput =
  | { type: 'ready'; workspaceRoot?: string; permissionMode: PermissionMode }
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'approval_request'; request: IdeApprovalRequest }
  | { type: 'approval_response'; id: string; choice: ConfirmChoice }
  | { type: 'done'; messageCount: number }
  | { type: 'error'; error: string }

export async function buildIdeMessages(
  request: IdeBridgeRequest,
  mcpRuntime: McpRuntimeContext | null,
): Promise<Message[]> {
  const prompt = request.prompt?.trim()
  const history = normalizeHistory(request.messages)
  if (!prompt && history.length === 0) throw new Error('prompt or messages is required')

  const messages: Message[] = [
    { role: 'system', content: await buildFreshSystemPrompt(mcpRuntime) },
    ...history,
  ]

  if (prompt) messages.push({ role: 'user', content: formatIdePrompt(prompt, request.context) })

  return messages
}

export async function buildFreshSystemPrompt(mcpRuntime: McpRuntimeContext | null): Promise<string> {
  const [memory, skills] = await Promise.all([
    loadProjectMemoryContext(),
    loadSkillsContext(),
  ])
  return buildSystemPrompt(memory, skills, mcpRuntime?.prompt ?? null, getPlanModeContext())
}

export function normalizeMaxTurns(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.min(20, Math.floor(value)))
}

export function normalizeWorkspaceRoot(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined
  if (!existsSync(path)) throw new Error(`workspaceRoot does not exist: ${path}`)
  return path
}

export function parseIdeRequest(value: unknown): IdeBridgeRequest {
  const object = typeof value === 'object' && value ? value as Partial<IdeBridgeRequest> : {}
  const parsedPermissionMode = typeof object.permissionMode === 'string'
    ? parsePermissionMode(object.permissionMode)
    : undefined
  if (object.permissionMode && !parsedPermissionMode) throw new Error(`unknown permissionMode: ${object.permissionMode}`)

  return {
    prompt: typeof object.prompt === 'string' ? object.prompt : undefined,
    messages: Array.isArray(object.messages) ? object.messages as IdeBridgeMessage[] : undefined,
    context: typeof object.context === 'object' && object.context ? object.context as IdeBridgeContext : undefined,
    permissionMode: parsedPermissionMode ?? undefined,
    maxTurns: object.maxTurns,
  }
}

function formatIdePrompt(prompt: string, context?: IdeBridgeContext): string {
  const ideContext = context ?? {}
  const sections = ['# User Request', prompt]

  if (ideContext.workspaceRoot || ideContext.activeFile || ideContext.selectedText || ideContext.diagnostics) {
    sections.push('', '# IDE Context')
  }
  if (ideContext.workspaceRoot) sections.push(`Workspace root: ${ideContext.workspaceRoot}`)
  if (ideContext.activeFile) sections.push(`Active file: ${ideContext.activeFile}`)
  if (ideContext.activeFileLanguage) sections.push(`Language: ${ideContext.activeFileLanguage}`)
  if (ideContext.selectedText) {
    sections.push('', 'Selected text:', fenced(ideContext.selectedText, ideContext.activeFileLanguage))
  }
  if (ideContext.diagnostics) {
    sections.push('', 'Diagnostics:', fenced(ideContext.diagnostics, 'text'))
  }

  return sections.join('\n')
}

function normalizeHistory(messages: IdeBridgeMessage[] | undefined): Message[] {
  if (!messages) return []
  return messages
    .filter(message => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .map(message => ({ role: message.role, content: message.content }))
}

function fenced(content: string, language = ''): string {
  const fence = content.includes('```') ? '````' : '```'
  return `${fence}${language}\n${content}\n${fence}`
}
