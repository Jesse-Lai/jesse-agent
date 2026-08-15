/**
 * ideServer.ts - long-lived local server for IDE frontends.
 *
 * The VS Code extension starts this once, then sends POST /ask requests instead
 * of spawning a fresh agent process for every prompt.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { stderr, stdout } from 'node:process'
import { promisify } from 'node:util'
import type { ConfirmChoice } from './confirm.js'
import { getLLMApiMode, getLLMModel, shutdownLLM, type Message } from './llm.js'
import { runAgent } from './loop.js'
import { loadMcpRuntimeContext, type McpRuntimeContext } from './mcp.js'
import { setExternalTools } from './tools/index.js'
import { getProjectRoot, setProjectRoot } from './workingDirectory.js'
import { setPermissionMode } from './permissionMode.js'
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
import { validateApprovalRun, validateCancelRun } from './runScope.js'

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
  abortController: AbortController
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
let busy = false
let approvalCounter = 0
let activeSession: IdeSessionState | null = null
let currentAbortController: AbortController | null = null
const pendingApprovals = new Map<string, PendingApproval>()
const backgroundRuns = new Map<string, BackgroundRun>()
const backgroundRunEvents: BackgroundRunEnvelope[] = []
const runSubscribers = new Set<RunSubscriber>()
let backgroundRunCursor = 0

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
    for (const subscriber of runSubscribers) {
      clearInterval(subscriber.keepAlive)
      subscriber.response.end()
    }
    runSubscribers.clear()
    await mcpRuntime?.close()
    await shutdownLLM()
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

    const assetRequestURL = new URL(req.url ?? '/', `http://${DEFAULT_HOST}`)
    const assetMatch = /^\/session\/assets\/([A-Za-z0-9._-]{1,160})\/([a-f0-9]{64}\.(?:png|jpg|webp))$/.exec(assetRequestURL.pathname)
    if (req.method === 'GET' && assetMatch?.[1] && assetMatch[2]) {
      await handleSessionAsset(
        res,
        assetMatch[1],
        assetMatch[2],
        normalizeWorkspaceRoot(assetRequestURL.searchParams.get('workspaceRoot') ?? undefined) ?? getProjectRoot(),
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

    if (busy) {
      const activeRun = [...backgroundRuns.values()]
        .filter(run => isActiveBackgroundRunStatus(run.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      writeJson(res, 409, {
        error: activeRun
          ? 'Another Do Anything Session is still running. Open JesseAgent to view or stop it, then retry this prompt.'
          : 'Jesse Agent is busy. Wait for the current request to finish or cancel it, then retry this prompt.',
        code: 'agent_busy',
        ...(activeRun ? { run: backgroundRunSnapshot(activeRun) } : {}),
      })
      return
    }

    if (req.method === 'POST' && req.url === '/runs') {
      busy = true
      try {
        await handleStartBackgroundRun(req, res)
      } catch (error) {
        busy = false
        throw error
      }
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
  await configureSessionWorkspace(session, request)
  await setProjectRoot(session.executionRoot)
  await refreshSessionSystemPrompt(session.messages)

  const prompt = request.prompt?.trim() ?? ''
  if (!prompt && !request.attachments?.length) throw new Error('prompt or attachments is required')

  const shouldGenerateTitle = !session.title && !session.messages.some(message => message.role === 'user')
  session.messages.push({
    role: 'user',
    content: formatIdePrompt(prompt, request.context),
    attachments: request.attachments?.length ? request.attachments : undefined,
  })
  session.persistedMessageCount = await recordNewMessages(session.transcript, session.messages, session.persistedMessageCount)
  const titlePromise = shouldGenerateTitle
    ? generateAndPersistSessionTitle(session, prompt || 'Image request')
    : Promise.resolve()
  const autoCompact = await autoCompactSessionIfNeeded(session)

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  writeJsonl(res, {
    type: 'ready',
    workspaceRoot,
    cwd: getProjectRoot(),
    workspace: session.metadata.workspace,
    sessionId: session.transcript.id,
    messageCount: session.messages.length,
    permissionMode,
    autoCompact,
  })

  const projectRoot = session.executionRoot
  const changelog = await startChangelogTracking({
    runId: randomUUID(),
    projectRoot,
    sessionId: session.transcript.id,
    startedAt: new Date().toISOString(),
    userRequest: prompt,
  })
  const context = createAgentRuntimeContext({
    projectRoot,
    cwd: projectRoot,
    originalProjectRoot: projectRoot,
    approvalHandler: createIdeApprovalHandler(res),
    onFileChange: change => changelog.fileChanges.push(change),
    onVerification: result => changelog.verifications.push(result),
  })

  const abortController = new AbortController()
  currentAbortController = abortController
  let cancelled = false
  let failed = false
  let finishedWithAnswer = false

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
      else if (outputEvent.type === 'error') failed = true
      if (outputEvent.type === 'assistant_text') {
        changelog.assistantResult = outputEvent.text
        finishedWithAnswer = true
      }
      await session.transcript.appendEvent(outputEvent)
      session.persistedMessageCount = await recordNewMessages(session.transcript, session.messages, session.persistedMessageCount)
      writeJsonl(res, { type: 'agent_event', event: outputEvent })
    }
  } finally {
    cancelled = cancelled || abortController.signal.aborted
    if (currentAbortController === abortController) currentAbortController = null
    try {
      session.persistedMessageCount = await recordNewMessages(session.transcript, session.messages, session.persistedMessageCount)
      await titlePromise
    } finally {
      await finishChangelogTracking(changelog, !cancelled && !failed && finishedWithAnswer)
    }
  }

  writeJsonl(res, { type: 'done', sessionId: session.transcript.id, messageCount: session.messages.length, cancelled })
  res.end()
}

async function handleStartBackgroundRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = parseIdeRequest(JSON.parse(await readBody(req)))
  const prompt = request.prompt?.trim() ?? ''
  if (!prompt && !request.attachments?.length) throw new Error('prompt or attachments is required')

  const workspaceRoot = await activateWorkspace(request.context?.workspaceRoot)
  const permissionMode = request.permissionMode ?? 'default'
  const modeResult = setPermissionMode(permissionMode)
  if (!modeResult.ok) throw new Error(modeResult.reason)

  const session = await ensureIdeSession(workspaceRoot, request.sessionId)
  await configureSessionWorkspace(session, request)
  await setProjectRoot(session.executionRoot)
  await refreshSessionSystemPrompt(session.messages)

  const shouldGenerateTitle = !session.title && !session.messages.some(message => message.role === 'user')
  session.messages.push({
    role: 'user',
    content: formatIdePrompt(prompt, request.context),
    attachments: request.attachments?.length ? request.attachments : undefined,
  })
  session.persistedMessageCount = await recordNewMessages(
    session.transcript,
    session.messages,
    session.persistedMessageCount,
  )
  const titlePromise = shouldGenerateTitle
    ? generateAndPersistSessionTitle(session, prompt || 'Image request')
    : Promise.resolve()
  const autoCompact = await autoCompactSessionIfNeeded(session)

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
      busy = false
    })
  })
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
  currentAbortController = run.abortController
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
      projectRoot: run.executionRoot,
      cwd: run.executionRoot,
      originalProjectRoot: run.executionRoot,
      approvalHandler: createBackgroundApprovalHandler(run),
      onFileChange: change => changelog.fileChanges.push(change),
      onVerification: result => changelog.verifications.push(result),
    })

    for await (const event of runAgent(run.session.messages, {
      context,
      maxTurns: normalizeMaxTurns(request.maxTurns),
      signal: run.abortController.signal,
      refreshSystemPrompt: async currentMessages => {
        const first = currentMessages[0]
        if (first?.role === 'system') first.content = await buildFreshSystemPrompt(mcpRuntime)
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
      await run.session.transcript.appendEvent(outputEvent)
      run.session.persistedMessageCount = await recordNewMessages(
        run.session.transcript,
        run.session.messages,
        run.session.persistedMessageCount,
      )
      emitBackgroundRunOutput(run, { type: 'agent_event', event: outputEvent })
    }
  } catch (error) {
    if (run.abortController.signal.aborted) cancelled = true
    else failure = error instanceof Error ? error.message : String(error)
    if (failure) emitBackgroundRunOutput(run, { type: 'error', error: failure })
  } finally {
    cancelled = cancelled || run.abortController.signal.aborted
    if (currentAbortController === run.abortController) currentAbortController = null
    const finalStatus: SessionRunStatus = cancelled ? 'cancelled' : failure ? 'failed' : 'completed'
    try {
      run.session.persistedMessageCount = await recordNewMessages(
        run.session.transcript,
        run.session.messages,
        run.session.persistedMessageCount,
      )
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
    busy = false
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
  const state: SessionRunState = {
    runId: run.id,
    status: run.status,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
  }
  run.session.lastRun = state
  await run.session.transcript.appendRunState(state)
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

async function autoCompactSessionIfNeeded(session: IdeSessionState): Promise<{
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
  await refreshSessionSystemPrompt(session.messages)
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
    sessionId &&
    activeSession.transcript.id === sessionId
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
    model: getLLMModel(),
    apiMode: getLLMApiMode(),
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
    executionRoot: opened.metadata.executionRoot ?? options.workspaceRoot,
    title: opened.title,
    metadata: opened.metadata,
    lastRun: opened.lastRun,
    resumed: opened.resumed,
  }
  state.lastRun = await recoverInterruptedRun(state.transcript.id, state.lastRun, options.workspaceRoot)
  state.persistedMessageCount = await recordNewMessages(state.transcript, state.messages, state.persistedMessageCount)
  return state
}

async function generateAndPersistSessionTitle(session: IdeSessionState, prompt: string): Promise<void> {
  const title = await generateSessionTitle(prompt, AbortSignal.timeout(15_000))
  if (!title || session.title) return
  await session.transcript.appendTitle(title, 'ai')
  session.title = title
  if (session.metadata.workspace?.kind === 'scratch') {
    const workspace = { ...session.metadata.workspace, displayName: title }
    session.metadata = mergeMetadata(session.metadata, { workspace })
    await session.transcript.appendMetadata({ workspace })
  }
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
  const workspaceRoot = normalizeWorkspaceRoot(url.searchParams.get('workspaceRoot') ?? undefined) ?? getProjectRoot()

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
  const workspaceRoot = normalizeWorkspaceRoot(readString(body.workspaceRoot)) ?? getProjectRoot()
  const session = await readSessionView(sessionId, workspaceRoot)
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
  const nextMetadata: SessionMetadata = {
    executionRoot: promoted.path,
    workspace: promoted,
  }
  session.metadata = mergeMetadata(session.metadata, nextMetadata)
  session.executionRoot = promoted.path
  await session.transcript.appendMetadata(nextMetadata)
  await setProjectRoot(promoted.path)
  await refreshSessionSystemPrompt(session.messages)

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
  if (!lastRun || !isActiveBackgroundRunStatus(lastRun.status) || backgroundRuns.has(lastRun.runId)) {
    return lastRun
  }
  const recovered = await markSessionRunInterrupted(sessionId, workspaceRoot)
  if (activeSession?.transcript.id === sessionId) activeSession.lastRun = recovered
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
  const workspaceRoot = normalizeWorkspaceRoot(readString(body.workspaceRoot)) ?? getProjectRoot()
  await appendSessionTitle(sessionId, title, workspaceRoot)
  if (activeSession?.transcript.id === sessionId) activeSession.title = title
  writeJson(res, 200, { ok: true, sessionId, title })
}

async function handleSessionArchive(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const sessionId = readString(body.sessionId)
  if (!sessionId) {
    writeJson(res, 400, { error: 'sessionId is required' })
    return
  }
  const workspaceRoot = normalizeWorkspaceRoot(readString(body.workspaceRoot)) ?? getProjectRoot()
  await appendSessionArchive(sessionId, true, workspaceRoot)
  if (activeSession?.transcript.id === sessionId) activeSession = null
  writeJson(res, 200, { ok: true, sessionId, archived: true })
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

async function handleCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const requestedRunId = readString(body.runId)
  const activeBackgroundRun = [...backgroundRuns.values()].find(run => isActiveBackgroundRunStatus(run.status))
  if (!validateCancelRun(activeBackgroundRun?.id, requestedRunId).ok) {
    writeJson(res, 409, {
      error: activeBackgroundRun
        ? 'The requested run is not the active run.'
        : 'The requested run is no longer active.',
      code: 'run_not_active',
      ...(activeBackgroundRun ? { run: backgroundRunSnapshot(activeBackgroundRun) } : {}),
    })
    return
  }

  const wasActive = Boolean(currentAbortController) || busy
  currentAbortController?.abort()
  rejectPendingApprovals(requestedRunId)
  writeJson(res, 200, { ok: true, cancelled: wasActive, ...(activeBackgroundRun ? { runId: activeBackgroundRun.id } : {}) })
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

main().catch(err => {
  stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
