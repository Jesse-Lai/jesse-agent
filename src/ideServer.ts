/**
 * ideServer.ts - long-lived local server for IDE frontends.
 *
 * The VS Code extension starts this once, then sends POST /ask requests instead
 * of spawning a fresh agent process for every prompt.
 */

import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { stderr, stdout } from 'node:process'
import { promisify } from 'node:util'
import type { ConfirmChoice } from './confirm.js'
import type { Message } from './llm.js'
import { runAgent } from './loop.js'
import { loadMcpRuntimeContext, type McpRuntimeContext } from './mcp.js'
import { setExternalTools } from './tools/index.js'
import { getProjectRoot, setProjectRoot } from './workingDirectory.js'
import { setPermissionMode } from './permissionMode.js'
import { createAgentRuntimeContext } from './runtimeContext.js'
import { compactMessages } from './compaction.js'
import { estimateContextChars } from './contextBudget.js'
import { formatGitDiff } from './gitDiff.js'
import { listSessionSummaries, openSession, type SessionTranscript } from './session.js'
import {
  buildFreshSystemPrompt,
  formatIdePrompt,
  normalizeMaxTurns,
  normalizeWorkspaceRoot,
  parseIdeRequest,
  type IdeApprovalRequest,
  type IdeBridgeOutput,
  type IdeBridgeRequest,
} from './ideProtocol.js'

console.log = (...args: unknown[]) => {
  stderr.write(`${args.map(String).join(' ')}\n`)
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 0
const MAX_BODY_BYTES = 2 * 1024 * 1024
const AGENT_ROOT = process.cwd()
const execFileAsync = promisify(execFile)

interface PendingApproval {
  resolve: (choice: ConfirmChoice) => void
  timer: NodeJS.Timeout
}

interface IdeSessionState {
  transcript: SessionTranscript
  messages: Message[]
  persistedMessageCount: number
  workspaceRoot: string
  resumed: boolean
}

let mcpRuntime: McpRuntimeContext | null = null
let busy = false
let approvalCounter = 0
let activeSession: IdeSessionState | null = null
let currentAbortController: AbortController | null = null
const pendingApprovals = new Map<string, PendingApproval>()

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    stdout.write([
      'Usage: npm run ide:server',
      '',
      'Starts a local HTTP server for IDE clients.',
      'POST /ask with an IdeBridgeRequest JSON body returns JSONL events.',
      'POST /approval resolves a pending IDE approval request.',
      '',
    ].join('\n'))
    return
  }

  mcpRuntime = await loadMcpRuntimeContext()
  setExternalTools(mcpRuntime.tools)

  const server = createServer((req, res) => {
    void routeRequest(req, res)
  })
  server.on('error', err => {
    stderr.write(`ide server error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  })

  const port = normalizePort(process.env.JESSE_IDE_PORT)
  server.listen(port, DEFAULT_HOST, () => {
    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : port
    writeStartupJson({ type: 'server_ready', host: DEFAULT_HOST, port: actualPort })
  })

  const close = async () => {
    currentAbortController?.abort()
    currentAbortController = null
    server.close()
    rejectPendingApprovals()
    await mcpRuntime?.close()
  }
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      writeJson(res, 200, {
        ok: true,
        busy,
        pendingApprovals: pendingApprovals.size,
        sessionId: activeSession?.transcript.id,
        messageCount: activeSession?.messages.length ?? 0,
        cwd: getProjectRoot(),
        agentRoot: AGENT_ROOT,
      })
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/sessions')) {
      await handleSessions(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/approval') {
      await handleApproval(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/cancel') {
      handleCancel(res)
      return
    }

    if (busy) {
      writeJson(res, 409, { error: 'Jesse Agent IDE server is busy. Wait for the current request to finish or cancel it.' })
      return
    }

    if (req.method === 'POST' && req.url === '/session/new') {
      await handleNewSession(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/session/resume') {
      await handleResumeSession(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/compact') {
      await handleCompact(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/diff') {
      await handleDiff(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/eval') {
      await handleEval(res)
      return
    }

    if (req.method !== 'POST' || req.url !== '/ask') {
      writeJson(res, 404, { error: 'not found' })
      return
    }

    busy = true
    try {
      const request = parseIdeRequest(JSON.parse(await readBody(req)))
      await runAsk(request, res)
    } finally {
      busy = false
    }
  } catch (err) {
    if (!res.headersSent) {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    } else {
      writeJsonl(res, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      res.end()
    }
  }
}

async function runAsk(request: IdeBridgeRequest, res: ServerResponse): Promise<void> {
  const workspaceRoot = await activateWorkspace(request.context?.workspaceRoot)

  const permissionMode = request.permissionMode ?? 'default'
  const modeResult = setPermissionMode(permissionMode)
  if (!modeResult.ok) throw new Error(modeResult.reason)

  const session = await ensureIdeSession(workspaceRoot, request.sessionId)
  await refreshSessionSystemPrompt(session.messages)

  const prompt = request.prompt?.trim()
  if (!prompt) throw new Error('prompt is required')

  session.messages.push({ role: 'user', content: formatIdePrompt(prompt, request.context) })
  session.persistedMessageCount = await recordNewMessages(session.transcript, session.messages, session.persistedMessageCount)

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  writeJsonl(res, {
    type: 'ready',
    workspaceRoot,
    cwd: getProjectRoot(),
    sessionId: session.transcript.id,
    messageCount: session.messages.length,
    permissionMode,
  })

  const projectRoot = workspaceRoot ?? getProjectRoot()
  const context = createAgentRuntimeContext({
    projectRoot,
    cwd: projectRoot,
    originalProjectRoot: projectRoot,
    approvalHandler: createIdeApprovalHandler(res),
  })

  const abortController = new AbortController()
  currentAbortController = abortController
  let cancelled = false

  try {
    for await (const event of runAgent(session.messages, {
      context,
      maxTurns: normalizeMaxTurns(request.maxTurns),
      signal: abortController.signal,
      refreshSystemPrompt: async currentMessages => {
        const first = currentMessages[0]
        if (first?.role === 'system') first.content = await buildFreshSystemPrompt(mcpRuntime)
      },
    })) {
      const outputEvent = event.type === 'error' && abortController.signal.aborted
        ? { type: 'error' as const, reason: 'Run cancelled by user.' }
        : event
      if (outputEvent.type === 'error' && isAbortLikeError(outputEvent.reason)) cancelled = true
      await session.transcript.appendEvent(outputEvent)
      session.persistedMessageCount = await recordNewMessages(session.transcript, session.messages, session.persistedMessageCount)
      writeJsonl(res, { type: 'agent_event', event: outputEvent })
    }
  } finally {
    cancelled = cancelled || abortController.signal.aborted
    if (currentAbortController === abortController) currentAbortController = null
    session.persistedMessageCount = await recordNewMessages(session.transcript, session.messages, session.persistedMessageCount)
  }

  writeJsonl(res, { type: 'done', sessionId: session.transcript.id, messageCount: session.messages.length, cancelled })
  res.end()
}

async function activateWorkspace(path: string | undefined): Promise<string> {
  const workspaceRoot = normalizeWorkspaceRoot(path)
  if (workspaceRoot) {
    process.chdir(workspaceRoot)
    await setProjectRoot(workspaceRoot)
    return workspaceRoot
  }
  return getProjectRoot()
}

async function ensureIdeSession(workspaceRoot: string, sessionId?: string): Promise<IdeSessionState> {
  if (
    activeSession &&
    activeSession.workspaceRoot === workspaceRoot &&
    (!sessionId || activeSession.transcript.id === sessionId)
  ) {
    return activeSession
  }

  activeSession = await openIdeSession({ workspaceRoot, resumeId: sessionId })
  return activeSession
}

async function openIdeSession(options: {
  workspaceRoot: string
  resumeId?: string
  continueLatest?: boolean
}): Promise<IdeSessionState> {
  const opened = await openSession({
    resumeId: options.resumeId,
    continueLatest: options.continueLatest === true,
    model: process.env.LLM_MODEL ?? 'gpt-4o-2024-11-20',
    apiMode: process.env.LLM_API_MODE ?? (process.env.LLM_BASE_URL?.includes('/responses') ? 'responses' : 'chat_completions'),
  })

  const messages: Message[] = opened.messages.length > 0
    ? opened.messages
    : [{ role: 'system', content: await buildFreshSystemPrompt(mcpRuntime) }]
  await refreshSessionSystemPrompt(messages)

  const state: IdeSessionState = {
    transcript: opened.transcript,
    messages,
    persistedMessageCount: opened.resumed ? messages.length : 0,
    workspaceRoot: options.workspaceRoot,
    resumed: opened.resumed,
  }
  state.persistedMessageCount = await recordNewMessages(state.transcript, state.messages, state.persistedMessageCount)
  return state
}

async function refreshSessionSystemPrompt(messages: Message[]): Promise<void> {
  const first = messages[0]
  if (first?.role === 'system') first.content = await buildFreshSystemPrompt(mcpRuntime)
}

async function recordNewMessages(
  transcript: SessionTranscript,
  messages: Message[],
  fromIndex: number,
): Promise<number> {
  for (let i = fromIndex; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message) continue
    await transcript.appendMessage(i, message)
  }
  return messages.length
}

async function handleSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/sessions', `http://${DEFAULT_HOST}`)
  const workspaceRoot = url.searchParams.get('workspaceRoot') ?? undefined
  if (workspaceRoot) await activateWorkspace(workspaceRoot)

  const rawLimit = Number(url.searchParams.get('limit') ?? 20)
  const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20
  writeJson(res, 200, { sessions: await listSessionSummaries(limit) })
}

async function handleNewSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const workspaceRoot = await activateWorkspace(readString(body.workspaceRoot))
  activeSession = await openIdeSession({ workspaceRoot })
  writeJson(res, 200, sessionPayload(activeSession))
}

async function handleResumeSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const workspaceRoot = await activateWorkspace(readString(body.workspaceRoot))
  activeSession = await openIdeSession({
    workspaceRoot,
    resumeId: readString(body.sessionId),
    continueLatest: !readString(body.sessionId),
  })
  writeJson(res, 200, sessionPayload(activeSession))
}

async function handleCompact(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  if (readString(body.workspaceRoot)) await activateWorkspace(readString(body.workspaceRoot))
  if (!activeSession) {
    writeJson(res, 400, { error: 'No active IDE session to compact.' })
    return
  }

  const result = await compactMessages(activeSession.messages)
  if (!result.compacted) {
    writeJson(res, 200, { compacted: false, reason: result.reason })
    return
  }

  await activeSession.transcript.appendCompactBoundary({
    beforeMessageCount: result.beforeMessageCount,
    afterMessageCount: result.afterMessageCount,
    compactedMessageCount: result.compactedMessageCount,
    keptRecentMessages: result.keptRecentMessages,
    summary: result.summary,
    messages: result.messages,
  })
  activeSession.messages.splice(0, activeSession.messages.length, ...result.messages)
  await refreshSessionSystemPrompt(activeSession.messages)
  activeSession.persistedMessageCount = activeSession.messages.length

  writeJson(res, 200, {
    compacted: true,
    sessionId: activeSession.transcript.id,
    beforeMessageCount: result.beforeMessageCount,
    afterMessageCount: result.afterMessageCount,
    compactedMessageCount: result.compactedMessageCount,
    keptRecentMessages: result.keptRecentMessages,
    contextChars: estimateContextChars(activeSession.messages),
  })
}

async function handleDiff(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  if (readString(body.workspaceRoot)) await activateWorkspace(readString(body.workspaceRoot))
  writeJson(res, 200, { text: await formatGitDiff() })
}

async function handleEval(res: ServerResponse): Promise<void> {
  try {
    const { stdout: out, stderr: err } = await execFileAsync(npmCommand(), ['run', 'eval', '--silent'], {
      cwd: AGENT_ROOT,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    writeJson(res, 200, { ok: true, text: [out, err].filter(Boolean).join('\n') })
  } catch (error) {
    const execError = error as ExecError
    writeJson(res, 200, {
      ok: false,
      text: [execError.stdout, execError.stderr, execError.message].filter(Boolean).join('\n'),
    })
  }
}

function handleCancel(res: ServerResponse): void {
  currentAbortController?.abort()
  rejectPendingApprovals()
  writeJson(res, 200, { ok: true, cancelled: Boolean(currentAbortController) || busy })
}

function rejectPendingApprovals(): void {
  for (const [id, pending] of pendingApprovals) {
    clearTimeout(pending.timer)
    pendingApprovals.delete(id)
    pending.resolve('reject_once')
  }
}

function sessionPayload(session: IdeSessionState): object {
  return {
    sessionId: session.transcript.id,
    workspaceRoot: session.workspaceRoot,
    resumed: session.resumed,
    messageCount: session.messages.length,
    messages: serializeMessagesForIde(session.messages),
  }
}

function serializeMessagesForIde(messages: Message[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.flatMap(message => {
    if (message.role !== 'user' && message.role !== 'assistant') return []
    const content = typeof message.content === 'string' ? displayMessageContent(message.content) : ''
    if (!content.trim()) return []
    return [{ role: message.role, content }]
  })
}

function displayMessageContent(content: string): string {
  if (!content.startsWith('# User Request\n')) return content
  const start = '# User Request\n'.length
  const end = content.indexOf('\n# IDE Context', start)
  return content.slice(start, end === -1 ? undefined : end).trim()
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (!raw.trim()) return {}
  const value = JSON.parse(raw) as unknown
  return typeof value === 'object' && value ? value as Record<string, unknown> : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function handleApproval(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req)) as { id?: unknown; choice?: unknown }
  const id = typeof body.id === 'string' ? body.id : ''
  const choice = normalizeApprovalChoice(body.choice)
  if (!id || !choice) {
    writeJson(res, 400, { error: 'approval id and valid choice are required' })
    return
  }

  const pending = pendingApprovals.get(id)
  if (!pending) {
    writeJson(res, 404, { error: 'approval request not found or already resolved' })
    return
  }

  clearTimeout(pending.timer)
  pendingApprovals.delete(id)
  pending.resolve(choice)
  writeJson(res, 200, { ok: true })
}

function createIdeApprovalHandler(res: ServerResponse) {
  return async function approve(request: Omit<IdeApprovalRequest, 'id'>): Promise<ConfirmChoice> {
    const id = `approval-${Date.now()}-${++approvalCounter}`
    const approvalRequest: IdeApprovalRequest = { id, ...request }

    writeJsonl(res, { type: 'approval_request', request: approvalRequest })

    const choice = await new Promise<ConfirmChoice>(resolve => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id)
        resolve('reject_once')
      }, 10 * 60 * 1000)
      pendingApprovals.set(id, { resolve, timer })
    })

    writeJsonl(res, { type: 'approval_response', id, choice })
    return choice
  }
}

function normalizeApprovalChoice(value: unknown): ConfirmChoice | null {
  if (value === 'allow_once' || value === 'allow_for_session' || value === 'reject_once') return value
  return null
}

function isAbortLikeError(reason: string): boolean {
  const normalized = reason.toLowerCase()
  return normalized.includes('cancelled') || normalized.includes('canceled') || normalized.includes('aborted')
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function writeJsonl(res: ServerResponse, output: IdeBridgeOutput): void {
  res.write(`${JSON.stringify(output)}\n`)
}

function writeStartupJson(value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`)
}

function normalizePort(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) return DEFAULT_PORT
  return parsed
}

interface ExecError extends Error {
  stdout?: string
  stderr?: string
}

main().catch(err => {
  stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
