/**
 * ideBridge.ts - one-shot JSONL bridge for editor frontends.
 *
 * The CLI remains the human terminal UI. This bridge is the first stable seam
 * for VS Code and future desktop/IM clients: read a JSON request from stdin,
 * run the existing agent core, and stream machine-readable JSONL events back.
 */

import { existsSync } from 'node:fs'
import { stdin, stdout, stderr } from 'node:process'
import type { Message } from './llm.js'
import { runAgent, type AgentEvent } from './loop.js'
import { buildSystemPrompt } from './prompt.js'
import { loadProjectMemoryContext } from './memory.js'
import { loadSkillsContext } from './skills.js'
import { loadMcpRuntimeContext, type McpRuntimeContext } from './mcp.js'
import { setExternalTools } from './tools/index.js'
import { setProjectRoot } from './workingDirectory.js'
import { getPlanModeContext } from './planMode.js'
import { parsePermissionMode, setPermissionMode, type PermissionMode } from './permissionMode.js'

console.log = (...args: unknown[]) => {
  stderr.write(`${args.map(String).join(' ')}\n`)
}

interface IdeBridgeRequest {
  prompt?: string
  messages?: IdeBridgeMessage[]
  context?: IdeBridgeContext
  permissionMode?: PermissionMode
  maxTurns?: number
}

interface IdeBridgeMessage {
  role: 'user' | 'assistant'
  content: string
}

interface IdeBridgeContext {
  workspaceRoot?: string
  activeFile?: string
  activeFileLanguage?: string
  selectedText?: string
  diagnostics?: string
}

type IdeBridgeOutput =
  | { type: 'ready'; workspaceRoot?: string; permissionMode: PermissionMode }
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'done'; messageCount: number }
  | { type: 'error'; error: string }

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    stdout.write([
      'Usage: npm run ide',
      '',
      'Reads an IdeBridgeRequest JSON object from stdin and writes JSONL events to stdout.',
      'Default permissionMode is plan so editor calls cannot block on terminal confirmations.',
      '',
    ].join('\n'))
    return
  }

  let mcpRuntime: McpRuntimeContext | null = null
  try {
    const request = parseRequest(await readStdin())
    const workspaceRoot = normalizeWorkspaceRoot(request.context?.workspaceRoot)
    if (workspaceRoot) {
      process.chdir(workspaceRoot)
      await setProjectRoot(workspaceRoot)
    }

    const permissionMode = request.permissionMode ?? 'plan'
    const modeResult = setPermissionMode(permissionMode)
    if (!modeResult.ok) throw new Error(modeResult.reason)

    mcpRuntime = await loadMcpRuntimeContext()
    setExternalTools(mcpRuntime.tools)

    writeJsonl({ type: 'ready', workspaceRoot, permissionMode })

    const messages = await buildMessages(request, mcpRuntime)
    for await (const event of runAgent(messages, {
      maxTurns: normalizeMaxTurns(request.maxTurns),
      refreshSystemPrompt: async currentMessages => {
        const first = currentMessages[0]
        if (first?.role === 'system') first.content = await buildFreshSystemPrompt(mcpRuntime)
      },
    })) {
      writeJsonl({ type: 'agent_event', event })
    }

    writeJsonl({ type: 'done', messageCount: messages.length })
  } catch (err) {
    writeJsonl({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  } finally {
    await mcpRuntime?.close()
  }
}

async function buildMessages(request: IdeBridgeRequest, mcpRuntime: McpRuntimeContext | null): Promise<Message[]> {
  const prompt = request.prompt?.trim()
  const history = normalizeHistory(request.messages)
  if (!prompt && history.length === 0) throw new Error('prompt or messages is required')

  const messages: Message[] = [
    { role: 'system', content: await buildFreshSystemPrompt(mcpRuntime) },
    ...history,
  ]

  if (prompt) {
    messages.push({ role: 'user', content: formatIdePrompt(prompt, request.context) })
  }

  return messages
}

async function buildFreshSystemPrompt(mcpRuntime: McpRuntimeContext | null): Promise<string> {
  const [memory, skills] = await Promise.all([
    loadProjectMemoryContext(),
    loadSkillsContext(),
  ])
  return buildSystemPrompt(memory, skills, mcpRuntime?.prompt ?? null, getPlanModeContext())
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

function normalizeMaxTurns(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.min(20, Math.floor(value)))
}

function normalizeWorkspaceRoot(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined
  if (!existsSync(path)) throw new Error(`workspaceRoot does not exist: ${path}`)
  return path
}

function parseRequest(raw: string): IdeBridgeRequest {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('stdin JSON request is empty')

  const value = JSON.parse(trimmed) as Partial<IdeBridgeRequest>
  const parsedPermissionMode = typeof value.permissionMode === 'string'
    ? parsePermissionMode(value.permissionMode)
    : undefined
  if (value.permissionMode && !parsedPermissionMode) throw new Error(`unknown permissionMode: ${value.permissionMode}`)
  const permissionMode = parsedPermissionMode ?? undefined

  return {
    prompt: typeof value.prompt === 'string' ? value.prompt : undefined,
    messages: Array.isArray(value.messages) ? value.messages as IdeBridgeMessage[] : undefined,
    context: typeof value.context === 'object' && value.context ? value.context as IdeBridgeContext : undefined,
    permissionMode,
    maxTurns: value.maxTurns,
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function fenced(content: string, language = ''): string {
  const fence = content.includes('```') ? '````' : '```'
  return `${fence}${language}\n${content}\n${fence}`
}

function writeJsonl(output: IdeBridgeOutput): void {
  stdout.write(`${JSON.stringify(output)}\n`)
}

main().catch(err => {
  stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
