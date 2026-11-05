/**
 * ideServer.ts - long-lived local server for IDE frontends.
 *
 * The VS Code extension starts this once, then sends POST /ask requests instead
 * of spawning a fresh agent process for every prompt.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stderr, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ConfirmChoice } from './confirm.js'
import { getLLMApiMode, getLLMModel, shutdownLLM, type Message } from './llm.js'
import { runAgent } from './loop.js'
import { loadMcpRuntimeContext, type McpRuntimeContext } from './mcp.js'
import { setExternalTools } from './tools/index.js'
import { validatePermissionMode, type PermissionMode } from './permissionMode.js'
import type { PermissionRule } from './permissions.js'
import { createAgentRuntimeContext } from './runtimeContext.js'
import { compactMessages } from './compaction.js'
import { CONTEXT_WARN_CHARS, estimateContextChars } from './contextBudget.js'
import { formatGitDiff } from './gitDiff.js'
import {
  appendSessionArchive,
  appendSessionTitle,
  listSessionSummaries,
  markSessionRunInterrupted,
  openSession,
  readSessionView,
  resolveSessionAssetPath,
  type SessionMetadata,
  type SessionRunState,
  type SessionRunStatus,
  type SessionSourceContext,
  type SessionTranscript,
} from './session.js'
import { generateSessionTitle } from './sessionTitle.js'
import {
  captureProjectChangeSnapshot,
  clearChangelogRunActive,
  compareProjectChangeSnapshots,
  finalizeDueChangelogs,
  markChangelogRunActive,
  recordChangelogRun,
  type ProjectChangeSnapshot,
} from './changelog.js'
import {
  createScratchWorkspace,
  promoteScratchWorkspace,
  type SessionWorkspaceMetadata,
} from './workspaces.js'
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
import type { RuntimeCommandResult, RuntimeFileChange } from './runtimeContext.js'
import { validateApprovalRun } from './runScope.js'

console.log = (...args: unknown[]) => {
  stderr.write(`${args.map(String).join(' ')}\n`)
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 0
const MAX_BODY_BYTES = 24 * 1024 * 1024
const AGENT_ROOT = process.cwd()
const IDE_AUTO_COMPACT_CHARS = numberFromEnv('IDE_AUTO_COMPACT_CHARS', CONTEXT_WARN_CHARS)
const execFileAsync = promisify(execFile)

interface PendingApproval {
  resolve: (choice: ConfirmChoice) => void
  timer: NodeJS.Timeout
  runId?: string
}

interface IdeSessionState {
  transcript: SessionTranscript
  messages: Message[]
  persistedMessageCount: number
  workspaceRoot: string
  executionRoot: string
  title: string | null
  metadata: SessionMetadata
  lastRun: SessionRunState | null
  resumed: boolean
  permissionRules: PermissionRule[]
  operationTail: Promise<void>
}

interface BackgroundRunSnapshot {
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

interface BackgroundRun extends BackgroundRunSnapshot {
  session: IdeSessionState
  messages: Message[]
  baseMessageCount: number
  permissionMode: PermissionMode
  abortController: AbortController
}

interface ForegroundRun {
  id: string
  sessionId: string
  workspaceRoot: string
  abortController: AbortController
}

interface PreparedIdeRun {
  workspaceRoot: string
  session: IdeSessionState
  messages: Message[]
  baseMessageCount: number
  permissionMode: PermissionMode
  autoCompact: Awaited<ReturnType<typeof autoCompactSessionIfNeeded>>
  titlePromise: Promise<void>
}

interface RunChangelogTracker {
  runId: string
  projectRoot: string
  sessionId: string
  startedAt: string
  userRequest: string
  before: ProjectChangeSnapshot
  fileChanges: RuntimeFileChange[]
  verifications: RuntimeCommandResult[]
  assistantResult: string
}

interface BackgroundRunEnvelope {
  cursor: number
  run: BackgroundRunSnapshot
  output?: IdeBridgeOutput
}

interface RunSubscriber {
  response: ServerResponse
  runId?: string
  sessionId?: string
  keepAlive: NodeJS.Timeout
}

let mcpRuntime: McpRuntimeContext | null = null
let approvalCounter = 0
const pendingApprovals = new Map<string, PendingApproval>()
const backgroundRuns = new Map<string, BackgroundRun>()
const foregroundRuns = new Map<string, ForegroundRun>()
const ideSessions = new Map<string, IdeSessionState>()
const ideSessionLoads = new Map<string, Promise<IdeSessionState>>()
const lastSessionByWorkspace = new Map<string, string>()
const backgroundRunEvents: BackgroundRunEnvelope[] = []
const runSubscribers = new Set<RunSubscriber>()
let backgroundRunCursor = 0

export interface IdeServerHandle {
  host: string
  port: number
  close: () => Promise<void>
}

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

  await startIdeServer()
}

export async function startIdeServer(options: {
  announce?: boolean
  registerSignalHandlers?: boolean
} = {}): Promise<IdeServerHandle> {
  const announce = options.announce !== false
  const registerSignalHandlers = options.registerSignalHandlers !== false

  mcpRuntime = await loadMcpRuntimeContext()
  setExternalTools(mcpRuntime.tools)

  const server = createServer((req, res) => {
    void routeRequest(req, res)
  })
  server.on('error', err => {
    stderr.write(`ide server error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  })

  const port = normalizePort(process.env.JESSE_IDE_PORT)
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error)
    server.once('error', onError)
    server.listen(port, DEFAULT_HOST, () => {
      server.off('error', onError)
      resolveListen()
    })
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  if (announce) writeStartupJson({ type: 'server_ready', host: DEFAULT_HOST, port: actualPort })

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const run of backgroundRuns.values()) run.abortController.abort()
    for (const run of foregroundRuns.values()) run.abortController.abort()
    rejectPendingApprovals()
    for (const subscriber of runSubscribers) {
      clearInterval(subscriber.keepAlive)
      subscriber.response.end()
    }
    runSubscribers.clear()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    await mcpRuntime?.close()
    mcpRuntime = null
    await shutdownLLM()
  }
  if (registerSignalHandlers) {
    process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
    process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
  }
  return { host: DEFAULT_HOST, port: actualPort, close }
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      writeJson(res, 200, {
        ok: true,
        busy: activeRunCount() > 0,
        activeRuns: activeRunCount(),
        pendingApprovals: pendingApprovals.size,
        sessionIds: [...new Set([
          ...activeBackgroundRuns().map(run => run.sessionId),
          ...[...foregroundRuns.values()].map(run => run.sessionId),
        ])],
        cwd: AGENT_ROOT,
        agentRoot: AGENT_ROOT,
      })
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/sessions')) {
      await handleSessions(req, res)
      return
    }

    const assetRequestURL = new URL(req.url ?? '/', `http://${DEFAULT_HOST}`)
    const assetMatch = /^\/session\/assets\/([A-Za-z0-9._-]{1,160})\/([a-f0-9]{64}\.(?:png|jpg|webp))$/.exec(assetRequestURL.pathname)
    if (req.method === 'GET' && assetMatch?.[1] && assetMatch[2]) {
      await handleSessionAsset(
        res,
        assetMatch[1],
        assetMatch[2],
        normalizeWorkspaceRoot(assetRequestURL.searchParams.get('workspaceRoot') ?? undefined) ?? AGENT_ROOT,
      )
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/runs/events')) {
      handleBackgroundRunEvents(req, res)
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/runs')) {
      handleBackgroundRuns(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/session/read') {
      await handleReadSession(req, res)
      return
    }

    if (req.method === 'PATCH' && req.url === '/session/title') {
      await handleSessionTitle(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/session/archive') {
      await handleSessionArchive(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/approval') {
      await handleApproval(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/cancel') {
      await handleCancel(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/runs') {
      await handleStartBackgroundRun(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/workspace/promote') {
      await handlePromoteWorkspace(req, res)
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

    const request = parseIdeRequest(JSON.parse(await readBody(req)))
    await runAsk(request, res)
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
  const prepared = await prepareIdeRun(request)
  const { workspaceRoot, session, messages, baseMessageCount, permissionMode, autoCompact, titlePromise } = prepared
  const prompt = request.prompt?.trim() ?? ''
  const runId = randomUUID()
  const abortController = new AbortController()
  foregroundRuns.set(runId, { id: runId, sessionId: session.transcript.id, workspaceRoot, abortController })

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  writeJsonl(res, {
    type: 'ready',
    workspaceRoot,
    cwd: session.executionRoot,
    workspace: session.metadata.workspace,
    sessionId: session.transcript.id,
    runId,
    messageCount: messages.length,
    permissionMode,
    autoCompact,
  })

  const projectRoot = session.executionRoot
  const changelog = await startChangelogTracking({
    runId,
    projectRoot,
    sessionId: session.transcript.id,
    startedAt: new Date().toISOString(),
    userRequest: prompt,
  })
  const context = createAgentRuntimeContext({
    sessionId: session.transcript.id,
    projectRoot,
    cwd: projectRoot,
    originalProjectRoot: projectRoot,
    permissionMode,
    permissionRules: session.permissionRules,
    signal: abortController.signal,
    approvalHandler: createIdeApprovalHandler(res, runId),
    onWorktreeEvent: event => withSessionLock(session, () => session.transcript.appendWorktreeEvent(event)),
    onFileChange: change => changelog.fileChanges.push(change),
    onVerification: result => changelog.verifications.push(result),
  })

  let cancelled = false
  let failed = false
  let finishedWithAnswer = false

  try {
    for await (const event of runAgent(messages, {
      context,
      maxTurns: normalizeMaxTurns(request.maxTurns),
      signal: abortController.signal,
      refreshSystemPrompt: async currentMessages => {
        const first = currentMessages[0]
        if (first?.role === 'system') first.content = await buildFreshSystemPrompt(mcpRuntime, context)
      },
    })) {
      const outputEvent = event.type === 'error' && abortController.signal.aborted
        ? { type: 'error' as const, reason: 'Run cancelled by user.' }
        : event
      if (outputEvent.type === 'error' && isAbortLikeError(outputEvent.reason)) cancelled = true
      else if (outputEvent.type === 'error') failed = true
      if (outputEvent.type === 'assistant_text') {
        changelog.assistantResult = outputEvent.text
        finishedWithAnswer = true
      }
      await appendSessionEvent(session, outputEvent)
      writeJsonl(res, { type: 'agent_event', event: outputEvent })
    }
  } finally {
    cancelled = cancelled || abortController.signal.aborted
    foregroundRuns.delete(runId)
    try {
      await commitRunMessages(session, messages, baseMessageCount)
      await titlePromise.catch(error => {
        stderr.write(`session title generation failed: ${error instanceof Error ? error.message : String(error)}\n`)
      })
    } finally {
      await finishChangelogTracking(changelog, !cancelled && !failed && finishedWithAnswer)
    }
  }

  writeJsonl(res, { type: 'done', sessionId: session.transcript.id, messageCount: session.messages.length, cancelled })
  res.end()
}

async function handleStartBackgroundRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = parseIdeRequest(JSON.parse(await readBody(req)))
  const prepared = await prepareIdeRun(request)
  const { workspaceRoot, session, messages, baseMessageCount, permissionMode, autoCompact, titlePromise } = prepared

  const now = new Date().toISOString()
  const run: BackgroundRun = {
    id: randomUUID(),
    sessionId: session.transcript.id,
    workspaceRoot,
    executionRoot: session.executionRoot,
    status: 'queued',
    source: session.metadata.source,
    workspace: session.metadata.workspace,
    createdAt: now,
    updatedAt: now,
    session,
    messages,
    baseMessageCount,
    permissionMode,
    abortController: new AbortController(),
  }
  backgroundRuns.set(run.id, run)
  await persistBackgroundRunState(run)
  emitBackgroundRunEnvelope(run)
  trimBackgroundRuns()

  writeJson(res, 202, {
    run: backgroundRunSnapshot(run),
    sessionId: run.sessionId,
    runId: run.id,
    cursor: backgroundRunCursor,
  })

  queueMicrotask(() => {
    void executeBackgroundRun(run, request, autoCompact, titlePromise).catch(error => {
      stderr.write(`background run failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    })
  })
}

async function prepareIdeRun(request: IdeBridgeRequest): Promise<PreparedIdeRun> {
  const prompt = request.prompt?.trim() ?? ''
  if (!prompt && !request.attachments?.length) throw new Error('prompt or attachments is required')

  const workspaceRoot = await activateWorkspace(request.context?.workspaceRoot)
  const permissionMode = request.permissionMode ?? 'default'
  const modeResult = validatePermissionMode(permissionMode)
  if (!modeResult.ok) throw new Error(modeResult.reason)

  const session = await ensureIdeSession(workspaceRoot, request.sessionId)
  const preparation = await withSessionLock(session, async () => {
    await configureSessionWorkspace(session, request)
    const promptContext = createAgentRuntimeContext({
      sessionId: session.transcript.id,
      projectRoot: session.executionRoot,
      cwd: session.executionRoot,
      originalProjectRoot: session.executionRoot,
      permissionMode,
      permissionRules: session.permissionRules,
    })
    await refreshSessionSystemPrompt(session.messages, promptContext)

    const shouldGenerateTitle = !session.title && !session.messages.some(message => message.role === 'user')
    const userMessage: Message = {
      role: 'user',
      content: formatIdePrompt(prompt, request.context),
      attachments: request.attachments?.length ? request.attachments : undefined,
    }
    session.messages.push(userMessage)
    await session.transcript.appendMessage(session.messages.length - 1, userMessage)
    session.persistedMessageCount = session.messages.length
    const autoCompact = await autoCompactSessionIfNeeded(session, promptContext)
    const messages = cloneMessages(session.messages)
    return {
      messages,
      baseMessageCount: messages.length,
      shouldGenerateTitle,
      autoCompact,
    }
  })

  const titlePromise = preparation.shouldGenerateTitle
    ? generateAndPersistSessionTitle(session, prompt || 'Image request')
    : Promise.resolve()
  return {
    workspaceRoot,
    session,
    messages: preparation.messages,
    baseMessageCount: preparation.baseMessageCount,
    permissionMode,
    autoCompact: preparation.autoCompact,
    titlePromise,
  }
}

async function configureSessionWorkspace(session: IdeSessionState, request: IdeBridgeRequest): Promise<void> {
  const context = request.context
  const source = sourceContextFromRequest(request)
  const shouldCreateManagedWorkspace = context?.chatMode === true && !session.metadata.executionRoot
  const scratchWorkspace = shouldCreateManagedWorkspace
    ? await createScratchWorkspace(session.transcript.id)
    : undefined
  const executionRoot = scratchWorkspace?.path ?? session.metadata.executionRoot ?? session.workspaceRoot

  const nextMetadata: SessionMetadata = {
    ...(context?.origin ? { origin: context.origin } : context?.chatMode ? { origin: 'web' as const } : {}),
    ...(source ? { source } : {}),
    ...(executionRoot !== session.workspaceRoot ? { executionRoot } : {}),
    ...(scratchWorkspace ? { workspace: scratchWorkspace } : {}),
  }
  if (Object.keys(nextMetadata).length > 0) {
    session.metadata = mergeMetadata(session.metadata, nextMetadata)
    session.executionRoot = session.metadata.executionRoot ?? session.workspaceRoot
    await session.transcript.appendMetadata(nextMetadata)
  }
}

async function executeBackgroundRun(
  run: BackgroundRun,
  request: IdeBridgeRequest,
  autoCompact: Awaited<ReturnType<typeof autoCompactSessionIfNeeded>>,
  titlePromise: Promise<void>,
): Promise<void> {
  // permissionMode is already validated before the detached run starts. Keep
  // the wire value explicit for every observer that joins later.
  const normalizedPermissionMode = request.permissionMode ?? 'default'
  let cancelled = false
  let failure: string | undefined
  const changelog = await startChangelogTracking({
    runId: run.id,
    projectRoot: run.executionRoot,
    sessionId: run.sessionId,
    startedAt: run.createdAt,
    userRequest: request.prompt?.trim() ?? '',
  })

  try {
    await setBackgroundRunStatus(run, 'running')
    emitBackgroundRunOutput(run, {
      type: 'ready',
      workspaceRoot: run.workspaceRoot,
      cwd: run.executionRoot,
      workspace: run.workspace,
      sessionId: run.sessionId,
      messageCount: run.session.messages.length,
      permissionMode: normalizedPermissionMode,
      autoCompact,
    })

    const context = createAgentRuntimeContext({
      sessionId: run.sessionId,
      projectRoot: run.executionRoot,
      cwd: run.executionRoot,
      originalProjectRoot: run.executionRoot,
      permissionMode: run.permissionMode,
      permissionRules: run.session.permissionRules,
      signal: run.abortController.signal,
      approvalHandler: createBackgroundApprovalHandler(run),
      onWorktreeEvent: event => withSessionLock(run.session, () => run.session.transcript.appendWorktreeEvent(event)),
      onFileChange: change => changelog.fileChanges.push(change),
      onVerification: result => changelog.verifications.push(result),
    })

    for await (const event of runAgent(run.messages, {
      context,
      maxTurns: normalizeMaxTurns(request.maxTurns),
      signal: run.abortController.signal,
      refreshSystemPrompt: async currentMessages => {
        const first = currentMessages[0]
        if (first?.role === 'system') first.content = await buildFreshSystemPrompt(mcpRuntime, context)
      },
    })) {
      const outputEvent = event.type === 'error' && run.abortController.signal.aborted
        ? { type: 'error' as const, reason: 'Run cancelled by user.' }
        : event
      if (outputEvent.type === 'error') {
        if (isAbortLikeError(outputEvent.reason)) cancelled = true
        else failure = outputEvent.reason
      }
      if (outputEvent.type === 'assistant_text') changelog.assistantResult = outputEvent.text
      await appendSessionEvent(run.session, outputEvent)
      emitBackgroundRunOutput(run, { type: 'agent_event', event: outputEvent })
    }
  } catch (error) {
    if (run.abortController.signal.aborted) cancelled = true
    else failure = error instanceof Error ? error.message : String(error)
    if (failure) emitBackgroundRunOutput(run, { type: 'error', error: failure })
  } finally {
    cancelled = cancelled || run.abortController.signal.aborted
    const finalStatus: SessionRunStatus = cancelled ? 'cancelled' : failure ? 'failed' : 'completed'
    try {
      await commitRunMessages(run.session, run.messages, run.baseMessageCount)
      await titlePromise.catch(error => {
        stderr.write(`session title generation failed: ${error instanceof Error ? error.message : String(error)}\n`)
      })
      await setBackgroundRunStatus(run, finalStatus, failure)
    } finally {
      await finishChangelogTracking(changelog, finalStatus === 'completed' && Boolean(changelog.assistantResult.trim()))
    }
    emitBackgroundRunOutput(run, {
      type: 'done',
      sessionId: run.sessionId,
      messageCount: run.session.messages.length,
      cancelled,
    })
  }
}

async function startChangelogTracking(input: {
  runId: string
  projectRoot: string
  sessionId: string
  startedAt: string
  userRequest: string
}): Promise<RunChangelogTracker> {
  try {
    await markChangelogRunActive(input.projectRoot, input.runId, input.startedAt)
  } catch (error) {
    stderr.write(`changelog active-run marker failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }

  let before: ProjectChangeSnapshot = { kind: 'plain', fingerprint: '', changedPaths: [] }
  try {
    before = await captureProjectChangeSnapshot(input.projectRoot)
  } catch (error) {
    stderr.write(`changelog baseline failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }

  return {
    ...input,
    before,
    fileChanges: [],
    verifications: [],
    assistantResult: '',
  }
}

async function finishChangelogTracking(tracker: RunChangelogTracker, completed: boolean): Promise<void> {
  try {
    if (completed) {
      const after = await captureProjectChangeSnapshot(tracker.projectRoot)
      const git = await compareProjectChangeSnapshots(tracker.projectRoot, tracker.before, after)
      await recordChangelogRun(tracker.projectRoot, {
        runId: tracker.runId,
        sessionId: tracker.sessionId,
        startedAt: tracker.startedAt,
        finishedAt: new Date().toISOString(),
        userRequest: tracker.userRequest,
        assistantResult: tracker.assistantResult,
        fileChanges: tracker.fileChanges,
        verifications: tracker.verifications,
        git,
      }, { configRoot: AGENT_ROOT })
    }
  } catch (error) {
    stderr.write(`changelog evidence recording failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  } finally {
    await clearChangelogRunActive(tracker.projectRoot, tracker.runId).catch(error => {
      stderr.write(`changelog active-run cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }

  queueMicrotask(() => {
    void finalizeDueChangelogs(tracker.projectRoot, { configRoot: AGENT_ROOT }).catch(error => {
      stderr.write(`changelog finalization failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    })
  })
}

function sourceContextFromRequest(request: IdeBridgeRequest): SessionSourceContext | undefined {
  const context = request.context
  if (!context?.sourceApp && !context?.sourceBundleIdentifier && !context?.sourceURL && !context?.sourceTitle) {
    return undefined
  }
  return {
    app: context.sourceApp?.slice(0, 200),
    bundleIdentifier: context.sourceBundleIdentifier?.slice(0, 300),
    url: context.sourceURL?.slice(0, 4_000),
    title: context.sourceTitle?.slice(0, 500),
  }
}

function mergeMetadata(current: SessionMetadata, next: SessionMetadata): SessionMetadata {
  return {
    ...current,
    ...next,
    source: current.source || next.source
      ? { ...current.source, ...next.source }
      : undefined,
    workspace: current.workspace || next.workspace
      ? { ...current.workspace, ...next.workspace } as SessionWorkspaceMetadata
      : undefined,
  }
}

async function setBackgroundRunStatus(
  run: BackgroundRun,
  status: SessionRunStatus,
  error?: string,
): Promise<void> {
  const now = new Date().toISOString()
  run.status = status
  run.updatedAt = now
  run.error = error
  if (status === 'completed' || status === 'failed' || status === 'cancelled') run.finishedAt = now
  await persistBackgroundRunState(run)
  emitBackgroundRunEnvelope(run)
}

async function persistBackgroundRunState(run: BackgroundRun): Promise<void> {
  await withSessionLock(run.session, async () => {
    const representative = representativeRunForSession(run)
    const state: SessionRunState = {
      runId: representative.id,
      status: representative.status,
      startedAt: representative.createdAt,
      updatedAt: representative.updatedAt,
      ...(representative.finishedAt ? { finishedAt: representative.finishedAt } : {}),
      ...(representative.error ? { error: representative.error } : {}),
    }
    run.session.lastRun = state
    await run.session.transcript.appendRunState(state)
  })
}

function representativeRunForSession(changedRun: BackgroundRun): BackgroundRun {
  const sessionRuns = [...backgroundRuns.values()].filter(candidate => (
    candidate.sessionId === changedRun.sessionId && candidate.workspaceRoot === changedRun.workspaceRoot
  ))
  const active = sessionRuns
    .filter(candidate => isActiveBackgroundRunStatus(candidate.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (active) return active
  return sessionRuns.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? changedRun
}

function backgroundRunSnapshot(run: BackgroundRun): BackgroundRunSnapshot {
  return {
    id: run.id,
    sessionId: run.sessionId,
    workspaceRoot: run.workspaceRoot,
    executionRoot: run.executionRoot,
    status: run.status,
    source: run.source,
    workspace: run.workspace,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
  }
}

function emitBackgroundRunOutput(run: BackgroundRun, output: IdeBridgeOutput): void {
  emitBackgroundRunEnvelope(run, output)
}

function emitBackgroundRunEnvelope(run: BackgroundRun, output?: IdeBridgeOutput): void {
  const envelope: BackgroundRunEnvelope = {
    cursor: ++backgroundRunCursor,
    run: backgroundRunSnapshot(run),
    ...(output ? { output } : {}),
  }
  backgroundRunEvents.push(envelope)
  if (backgroundRunEvents.length > 2_000) backgroundRunEvents.splice(0, backgroundRunEvents.length - 2_000)
  for (const subscriber of runSubscribers) {
    if (!runEnvelopeMatches(envelope, subscriber.runId, subscriber.sessionId)) continue
    writeRunServerEvent(subscriber.response, envelope)
  }
}

function handleBackgroundRuns(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/runs', `http://${DEFAULT_HOST}`)
  const runId = url.searchParams.get('runId') ?? undefined
  const sessionId = url.searchParams.get('sessionId') ?? undefined
  const includeEvents = url.searchParams.get('includeEvents') === '1'
  const runs = [...backgroundRuns.values()]
    .filter(run => (!runId || run.id === runId) && (!sessionId || run.sessionId === sessionId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(backgroundRunSnapshot)
  const events = includeEvents
    ? backgroundRunEvents.filter(envelope => runEnvelopeMatches(envelope, runId, sessionId))
    : undefined
  writeJson(res, 200, { cursor: backgroundRunCursor, runs, ...(events ? { events } : {}) })
}

function handleBackgroundRunEvents(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/runs/events', `http://${DEFAULT_HOST}`)
  const runId = url.searchParams.get('runId') ?? undefined
  const sessionId = url.searchParams.get('sessionId') ?? undefined
  const headerCursor = Array.isArray(req.headers['last-event-id'])
    ? req.headers['last-event-id'][0]
    : req.headers['last-event-id']
  // EventSource supplies Last-Event-ID on an automatic reconnect. Prefer it
  // over the original query cursor so already-delivered output is not replayed.
  const rawAfter = Number(headerCursor ?? url.searchParams.get('after') ?? 0)
  const after = Number.isSafeInteger(rawAfter) && rawAfter >= 0 ? rawAfter : 0

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  for (const envelope of backgroundRunEvents) {
    if (envelope.cursor <= after || !runEnvelopeMatches(envelope, runId, sessionId)) continue
    writeRunServerEvent(res, envelope)
  }

  const keepAlive = setInterval(() => {
    if (!res.destroyed) res.write(': keep-alive\n\n')
  }, 15_000)
  const subscriber: RunSubscriber = { response: res, runId, sessionId, keepAlive }
  runSubscribers.add(subscriber)
  req.on('close', () => {
    clearInterval(keepAlive)
    runSubscribers.delete(subscriber)
  })
}

function writeRunServerEvent(res: ServerResponse, envelope: BackgroundRunEnvelope): void {
  if (res.destroyed || res.writableEnded) return
  try {
    res.write(`id: ${envelope.cursor}\nevent: run\ndata: ${JSON.stringify(envelope)}\n\n`)
  } catch {
    // The close handler removes disconnected subscribers.
  }
}

function runEnvelopeMatches(envelope: BackgroundRunEnvelope, runId?: string, sessionId?: string): boolean {
  return (!runId || envelope.run.id === runId) && (!sessionId || envelope.run.sessionId === sessionId)
}

function trimBackgroundRuns(): void {
  const completed = [...backgroundRuns.values()]
    .filter(run => run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  for (const run of completed.slice(50)) backgroundRuns.delete(run.id)
}

async function autoCompactSessionIfNeeded(
  session: IdeSessionState,
  context?: ReturnType<typeof createAgentRuntimeContext>,
): Promise<{
  beforeMessageCount: number
  afterMessageCount: number
  compactedMessageCount: number
  keptRecentMessages: number
} | undefined> {
  const chars = estimateContextChars(session.messages)
  if (chars < IDE_AUTO_COMPACT_CHARS) return undefined

  const result = await compactMessages(session.messages)
  if (!result.compacted) return undefined

  await session.transcript.appendCompactBoundary({
    beforeMessageCount: result.beforeMessageCount,
    afterMessageCount: result.afterMessageCount,
    compactedMessageCount: result.compactedMessageCount,
    keptRecentMessages: result.keptRecentMessages,
    summary: result.summary,
    messages: result.messages,
  })
  session.messages.splice(0, session.messages.length, ...result.messages)
  await refreshSessionSystemPrompt(session.messages, context)
  session.persistedMessageCount = session.messages.length

  return {
    beforeMessageCount: result.beforeMessageCount,
    afterMessageCount: result.afterMessageCount,
    compactedMessageCount: result.compactedMessageCount,
    keptRecentMessages: result.keptRecentMessages,
  }
}

async function activateWorkspace(path: string | undefined): Promise<string> {
  const workspaceRoot = normalizeWorkspaceRoot(path)
  if (workspaceRoot) {
    const resolved = await realpath(workspaceRoot)
    const info = await stat(resolved)
    if (!info.isDirectory()) throw new Error(`workspaceRoot is not a directory: ${workspaceRoot}`)
    return resolved
  }
  return AGENT_ROOT
}

async function ensureIdeSession(workspaceRoot: string, sessionId?: string): Promise<IdeSessionState> {
  if (!sessionId) return registerIdeSession(await openIdeSession({ workspaceRoot }))

  const key = ideSessionKey(workspaceRoot, sessionId)
  const cached = ideSessions.get(key)
  if (cached) {
    lastSessionByWorkspace.set(workspaceRoot, sessionId)
    return cached
  }

  const pending = ideSessionLoads.get(key)
  if (pending) return pending
  const load = openIdeSession({ workspaceRoot, resumeId: sessionId })
    .then(registerIdeSession)
    .finally(() => ideSessionLoads.delete(key))
  ideSessionLoads.set(key, load)
  return load
}

async function openIdeSession(options: {
  workspaceRoot: string
  resumeId?: string
  continueLatest?: boolean
}): Promise<IdeSessionState> {
  const opened = await openSession({
    resumeId: options.resumeId,
    continueLatest: options.continueLatest === true,
    model: getLLMModel(),
    apiMode: getLLMApiMode(),
    root: options.workspaceRoot,
  })

  const bootstrapContext = createAgentRuntimeContext({
    sessionId: opened.transcript.id,
    projectRoot: opened.metadata.executionRoot ?? options.workspaceRoot,
    cwd: opened.metadata.executionRoot ?? options.workspaceRoot,
    originalProjectRoot: opened.metadata.executionRoot ?? options.workspaceRoot,
  })
  const messages: Message[] = opened.messages.length > 0
    ? opened.messages
    : [{ role: 'system', content: await buildFreshSystemPrompt(mcpRuntime, bootstrapContext) }]
  await refreshSessionSystemPrompt(messages, bootstrapContext)

  const state: IdeSessionState = {
    transcript: opened.transcript,
    messages,
    persistedMessageCount: opened.resumed ? messages.length : 0,
    workspaceRoot: options.workspaceRoot,
    executionRoot: opened.metadata.executionRoot ?? options.workspaceRoot,
    title: opened.title,
    metadata: opened.metadata,
    lastRun: opened.lastRun,
    resumed: opened.resumed,
    permissionRules: [],
    operationTail: Promise.resolve(),
  }
  state.lastRun = await recoverInterruptedRun(state.transcript.id, state.lastRun, options.workspaceRoot)
  state.persistedMessageCount = await recordNewMessages(state.transcript, state.messages, state.persistedMessageCount)
  return state
}

function registerIdeSession(session: IdeSessionState): IdeSessionState {
  ideSessions.set(ideSessionKey(session.workspaceRoot, session.transcript.id), session)
  lastSessionByWorkspace.set(session.workspaceRoot, session.transcript.id)
  return session
}

function ideSessionKey(workspaceRoot: string, sessionId: string): string {
  return `${workspaceRoot}\u001f${sessionId}`
}

async function generateAndPersistSessionTitle(session: IdeSessionState, prompt: string): Promise<void> {
  const title = await generateSessionTitle(prompt, AbortSignal.timeout(15_000))
  if (!title) return
  await withSessionLock(session, async () => {
    if (session.title) return
    await session.transcript.appendTitle(title, 'ai')
    session.title = title
    if (session.metadata.workspace?.kind === 'scratch') {
      const workspace = { ...session.metadata.workspace, displayName: title }
      session.metadata = mergeMetadata(session.metadata, { workspace })
      await session.transcript.appendMetadata({ workspace })
    }
  })
}

async function refreshSessionSystemPrompt(
  messages: Message[],
  context?: ReturnType<typeof createAgentRuntimeContext>,
): Promise<void> {
  const first = messages[0]
  if (first?.role === 'system') first.content = await buildFreshSystemPrompt(mcpRuntime, context)
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

async function withSessionLock<T>(session: IdeSessionState, operation: () => Promise<T>): Promise<T> {
  const previous = session.operationTail
  let release!: () => void
  session.operationTail = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

async function appendSessionEvent(
  session: IdeSessionState,
  event: Parameters<SessionTranscript['appendEvent']>[0],
): Promise<void> {
  await withSessionLock(session, async () => {
    await session.transcript.appendEvent(event)
  })
}

async function commitRunMessages(
  session: IdeSessionState,
  runMessages: Message[],
  baseMessageCount: number,
): Promise<void> {
  const additions = runMessages.slice(baseMessageCount)
  if (additions.length === 0) return
  await withSessionLock(session, async () => {
    for (const message of additions) {
      const index = session.messages.length
      session.messages.push(message)
      await session.transcript.appendMessage(index, message)
    }
    session.persistedMessageCount = session.messages.length
  })
}

function cloneMessages(messages: Message[]): Message[] {
  return structuredClone(messages)
}

function activeBackgroundRuns(): BackgroundRun[] {
  return [...backgroundRuns.values()].filter(run => isActiveBackgroundRunStatus(run.status))
}

function activeRunCount(): number {
  return activeBackgroundRuns().length + foregroundRuns.size
}

async function handleSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/sessions', `http://${DEFAULT_HOST}`)
  const workspaceRoot = await activateWorkspace(url.searchParams.get('workspaceRoot') ?? undefined)

  const rawLimit = Number(url.searchParams.get('limit') ?? 20)
  const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20
  const sessions = await listSessionSummaries(limit, workspaceRoot)
  await Promise.all(sessions.map(async session => {
    session.lastRun = await recoverInterruptedRun(session.id, session.lastRun, workspaceRoot)
  }))
  writeJson(res, 200, { sessions })
}

async function handleReadSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const sessionId = readString(body.sessionId)
  if (!sessionId) {
    writeJson(res, 400, { error: 'sessionId is required' })
    return
  }
  const workspaceRoot = await activateWorkspace(readString(body.workspaceRoot))
  const cached = ideSessions.get(ideSessionKey(workspaceRoot, sessionId))
  const session = cached
    ? {
        id: cached.transcript.id,
        title: cached.title,
        messages: cached.messages,
        metadata: cached.metadata,
        lastRun: cached.lastRun,
      }
    : await readSessionView(sessionId, workspaceRoot)
  session.lastRun = await recoverInterruptedRun(session.id, session.lastRun, workspaceRoot)
  writeJson(res, 200, {
    sessionId: session.id,
    title: session.title,
    workspaceRoot,
    executionRoot: session.metadata.executionRoot ?? workspaceRoot,
    metadata: session.metadata,
    lastRun: session.lastRun,
    messages: serializeMessagesForIde(session.messages, session.id, workspaceRoot),
  })
}

async function handleSessionAsset(
  res: ServerResponse,
  sessionId: string,
  assetId: string,
  workspaceRoot: string,
): Promise<void> {
  try {
    const assetPath = resolveSessionAssetPath(sessionId, assetId, workspaceRoot)
    const data = await readFile(assetPath)
    res.writeHead(200, {
      'content-type': assetId.endsWith('.jpg')
        ? 'image/jpeg'
        : assetId.endsWith('.webp')
          ? 'image/webp'
          : 'image/png',
      'content-length': data.length,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    res.end(data)
  } catch {
    writeJson(res, 404, { error: 'session image not found' })
  }
}

async function handlePromoteWorkspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const sessionId = readString(body.sessionId)
  const requestedName = readString(body.name)
  if (!sessionId || !requestedName) {
    writeJson(res, 400, { error: 'sessionId and name are required' })
    return
  }

  const workspaceRoot = await activateWorkspace(readString(body.workspaceRoot))
  const session = await ensureIdeSession(workspaceRoot, sessionId)
  const workspace = session.metadata.workspace
  if (!workspace) {
    writeJson(res, 409, { error: 'This session does not have a managed workspace.' })
    return
  }

  const promoted = await promoteScratchWorkspace(workspace, requestedName)
  await withSessionLock(session, async () => {
    const nextMetadata: SessionMetadata = {
      executionRoot: promoted.path,
      workspace: promoted,
    }
    session.metadata = mergeMetadata(session.metadata, nextMetadata)
    session.executionRoot = promoted.path
    await session.transcript.appendMetadata(nextMetadata)
    const context = createAgentRuntimeContext({
      sessionId,
      projectRoot: promoted.path,
      cwd: promoted.path,
      originalProjectRoot: promoted.path,
      permissionRules: session.permissionRules,
    })
    await refreshSessionSystemPrompt(session.messages, context)
  })

  for (const run of backgroundRuns.values()) {
    if (run.sessionId !== sessionId) continue
    run.executionRoot = promoted.path
    run.workspace = promoted
  }

  writeJson(res, 200, {
    ok: true,
    sessionId,
    workspaceRoot,
    executionRoot: promoted.path,
    workspace: promoted,
  })
}

async function recoverInterruptedRun(
  sessionId: string,
  lastRun: SessionRunState | null,
  workspaceRoot: string,
): Promise<SessionRunState | null> {
  const liveBackground = backgroundRuns.get(lastRun?.runId ?? '')
  const liveForeground = foregroundRuns.get(lastRun?.runId ?? '')
  if (
    !lastRun
    || !isActiveBackgroundRunStatus(lastRun.status)
    || (liveBackground && isActiveBackgroundRunStatus(liveBackground.status))
    || liveForeground
  ) {
    return lastRun
  }
  const recovered = await markSessionRunInterrupted(sessionId, workspaceRoot)
  const cached = ideSessions.get(ideSessionKey(workspaceRoot, sessionId))
  if (cached) cached.lastRun = recovered
  return recovered
}

function isActiveBackgroundRunStatus(status: SessionRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_approval'
}

async function handleSessionTitle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const sessionId = readString(body.sessionId)
  const title = readString(body.title)
  if (!sessionId || !title) {
    writeJson(res, 400, { error: 'sessionId and title are required' })
    return
  }
  if (title.length > 80) {
    writeJson(res, 400, { error: 'title must be 80 characters or fewer' })
    return
  }
  const workspaceRoot = await activateWorkspace(readString(body.workspaceRoot))
  const cached = ideSessions.get(ideSessionKey(workspaceRoot, sessionId))
  if (cached) {
    await withSessionLock(cached, async () => {
      await cached.transcript.appendTitle(title, 'user')
      cached.title = title
    })
  } else {
    await appendSessionTitle(sessionId, title, workspaceRoot)
  }
  writeJson(res, 200, { ok: true, sessionId, title })
}

async function handleSessionArchive(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const sessionId = readString(body.sessionId)
  if (!sessionId) {
    writeJson(res, 400, { error: 'sessionId is required' })
    return
  }
  const workspaceRoot = await activateWorkspace(readString(body.workspaceRoot))
  await appendSessionArchive(sessionId, true, workspaceRoot)
  ideSessions.delete(ideSessionKey(workspaceRoot, sessionId))
  if (lastSessionByWorkspace.get(workspaceRoot) === sessionId) lastSessionByWorkspace.delete(workspaceRoot)
  writeJson(res, 200, { ok: true, sessionId, archived: true })
}

async function handleNewSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const workspaceRoot = await activateWorkspace(readString(body.workspaceRoot))
  const session = registerIdeSession(await openIdeSession({ workspaceRoot }))
  writeJson(res, 200, sessionPayload(session))
}

async function handleResumeSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const workspaceRoot = await activateWorkspace(readString(body.workspaceRoot))
  const session = registerIdeSession(await openIdeSession({
    workspaceRoot,
    resumeId: readString(body.sessionId),
    continueLatest: !readString(body.sessionId),
  }))
  writeJson(res, 200, sessionPayload(session))
}

async function handleCompact(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const workspaceRoot = await activateWorkspace(readString(body.workspaceRoot))
  const sessionId = readString(body.sessionId) ?? lastSessionByWorkspace.get(workspaceRoot)
  if (!sessionId) {
    writeJson(res, 400, { error: 'No active IDE session to compact.' })
    return
  }
  const session = await ensureIdeSession(workspaceRoot, sessionId)
  const payload = await withSessionLock(session, async () => {
    const result = await compactMessages(session.messages)
    if (!result.compacted) return { compacted: false as const, reason: result.reason }

    await session.transcript.appendCompactBoundary({
      beforeMessageCount: result.beforeMessageCount,
      afterMessageCount: result.afterMessageCount,
      compactedMessageCount: result.compactedMessageCount,
      keptRecentMessages: result.keptRecentMessages,
      summary: result.summary,
      messages: result.messages,
    })
    session.messages.splice(0, session.messages.length, ...result.messages)
    const context = createAgentRuntimeContext({
      sessionId,
      projectRoot: session.executionRoot,
      cwd: session.executionRoot,
      originalProjectRoot: session.executionRoot,
      permissionRules: session.permissionRules,
    })
    await refreshSessionSystemPrompt(session.messages, context)
    session.persistedMessageCount = session.messages.length
    return {
      compacted: true as const,
      sessionId: session.transcript.id,
      beforeMessageCount: result.beforeMessageCount,
      afterMessageCount: result.afterMessageCount,
      compactedMessageCount: result.compactedMessageCount,
      keptRecentMessages: result.keptRecentMessages,
      contextChars: estimateContextChars(session.messages),
    }
  })
  writeJson(res, 200, payload)
}

async function handleDiff(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const workspaceRoot = await activateWorkspace(readString(body.workspaceRoot))
  writeJson(res, 200, { text: await formatGitDiff(workspaceRoot) })
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

async function handleCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const requestedRunId = readString(body.runId)
  const activeRuns: Array<{
    id: string
    controller: AbortController
    snapshot?: BackgroundRunSnapshot
  }> = [
    ...activeBackgroundRuns().map(run => ({ id: run.id, controller: run.abortController, snapshot: backgroundRunSnapshot(run) })),
    ...[...foregroundRuns.values()].map(run => ({ id: run.id, controller: run.abortController })),
  ]
  const target = requestedRunId
    ? activeRuns.find(run => run.id === requestedRunId)
    : activeRuns.length === 1
      ? activeRuns[0]
      : undefined

  if (!requestedRunId && activeRuns.length > 1) {
    writeJson(res, 409, {
      error: 'Multiple runs are active. Specify runId to cancel exactly one run.',
      code: 'run_id_required',
      runs: activeRuns.map(run => run.snapshot).filter(Boolean),
    })
    return
  }
  if (!target) {
    writeJson(res, 409, {
      error: 'The requested run is no longer active.',
      code: 'run_not_active',
    })
    return
  }

  target.controller.abort()
  rejectPendingApprovals(target.id)
  writeJson(res, 200, { ok: true, cancelled: true, runId: target.id })
}

function rejectPendingApprovals(runId?: string): void {
  for (const [id, pending] of pendingApprovals) {
    if (runId && pending.runId && pending.runId !== runId) continue
    clearTimeout(pending.timer)
    pendingApprovals.delete(id)
    pending.resolve('reject_once')
  }
}

function sessionPayload(session: IdeSessionState): object {
  return {
    sessionId: session.transcript.id,
    title: session.title,
    workspaceRoot: session.workspaceRoot,
    executionRoot: session.executionRoot,
    metadata: session.metadata,
    lastRun: session.lastRun,
    resumed: session.resumed,
    messageCount: session.messages.length,
    messages: serializeMessagesForIde(session.messages, session.transcript.id, session.workspaceRoot),
  }
}

function serializeMessagesForIde(
  messages: Message[],
  sessionId: string,
  workspaceRoot: string,
): Array<{
  role: 'user' | 'assistant'
  content: string
  attachments?: Array<{
    type: 'image'
    mimeType: string
    assetId?: string
    url?: string
    name?: string
    byteLength?: number
    width?: number
    height?: number
    source?: 'user' | 'generated'
  }>
}> {
  return messages.flatMap(message => {
    if (message.role !== 'user' && message.role !== 'assistant') return []
    const content = typeof message.content === 'string' ? displayMessageContent(message.content) : ''
    const attachments = (message.attachments ?? []).map(attachment => ({
      type: attachment.type,
      mimeType: attachment.mimeType,
      assetId: attachment.assetId,
      url: attachment.assetId
        ? `/api/session/assets/${encodeURIComponent(sessionId)}/${encodeURIComponent(attachment.assetId)}?workspaceRoot=${encodeURIComponent(workspaceRoot)}`
        : undefined,
      name: attachment.name,
      byteLength: attachment.byteLength,
      width: attachment.width,
      height: attachment.height,
      source: attachment.source,
    }))
    if (!content.trim() && attachments.length === 0) return []
    return [{ role: message.role, content, attachments: attachments.length ? attachments : undefined }]
  })
}

function displayMessageContent(content: string): string {
  if (!content.startsWith('# User Request\n')) return content
  const start = '# User Request\n'.length
  const boundaries = ['\n# Source Context', '\n# IDE Context']
    .map(marker => content.indexOf(marker, start))
    .filter(index => index !== -1)
  const end = boundaries.length > 0 ? Math.min(...boundaries) : undefined
  return content.slice(start, end).trim()
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
  const body = JSON.parse(await readBody(req)) as { id?: unknown; choice?: unknown; runId?: unknown }
  const id = typeof body.id === 'string' ? body.id : ''
  const runId = typeof body.runId === 'string' ? body.runId : undefined
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
  if (!validateApprovalRun(pending.runId, runId).ok) {
    writeJson(res, 409, { error: 'approval does not belong to the requested run', code: 'approval_run_mismatch' })
    return
  }

  clearTimeout(pending.timer)
  pendingApprovals.delete(id)
  pending.resolve(choice)
  writeJson(res, 200, { ok: true })
}

function createIdeApprovalHandler(res: ServerResponse, runId: string) {
  return async function approve(request: Omit<IdeApprovalRequest, 'id'>): Promise<ConfirmChoice> {
    const id = `approval-${Date.now()}-${++approvalCounter}`
    const approvalRequest: IdeApprovalRequest = { id, ...request }

    writeJsonl(res, { type: 'approval_request', request: approvalRequest })

    const choice = await new Promise<ConfirmChoice>(resolve => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id)
        resolve('reject_once')
      }, 10 * 60 * 1000)
      pendingApprovals.set(id, { resolve, timer, runId })
    })

    writeJsonl(res, { type: 'approval_response', id, choice })
    return choice
  }
}

function createBackgroundApprovalHandler(run: BackgroundRun) {
  return async function approve(request: Omit<IdeApprovalRequest, 'id'>): Promise<ConfirmChoice> {
    const id = `approval-${Date.now()}-${++approvalCounter}`
    const approvalRequest: IdeApprovalRequest = { id, ...request }

    await setBackgroundRunStatus(run, 'waiting_approval')
    emitBackgroundRunOutput(run, { type: 'approval_request', request: approvalRequest })

    const choice = await new Promise<ConfirmChoice>(resolve => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id)
        resolve('reject_once')
      }, 10 * 60 * 1000)
      pendingApprovals.set(id, { resolve, timer, runId: run.id })
    })

    emitBackgroundRunOutput(run, { type: 'approval_response', id, choice })
    if (!run.abortController.signal.aborted) await setBackgroundRunStatus(run, 'running')
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

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

interface ExecError extends Error {
  stdout?: string
  stderr?: string
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : ''
if (entryPoint && fileURLToPath(import.meta.url) === entryPoint) {
  main().catch(err => {
    stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  })
}
