import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, resolve } from 'node:path'
import { confirm } from './confirm.js'
import { classifyBashCommand } from './bashClassifier.js'
import { checkPermission, describeRule, rememberSessionAllowRule } from './permissions.js'
import { getPermissionMode, permissionModeTitle } from './permissionMode.js'
import type { AgentRuntimeContext } from './runtimeContext.js'
import type { ToolApprovalRequest } from './toolApprovals.js'
import {
  isPathWithinProjectRoot,
  resolveWorkingDirectory,
  resolveWritableToolPath,
} from './workingDirectory.js'
import type { CallOptions, LLMResponse, LLMStreamEvent, Message } from './llm.js'
import { generateImage } from './imageGeneration.js'
import { parseImageDataURL, type MessageAttachment } from './attachments.js'

const COPILOT_MODEL = process.env.COPILOT_MODEL?.trim() || 'gpt-5.6-sol'
const COPILOT_LOG_LEVEL = process.env.COPILOT_LOG_LEVEL?.trim() || undefined
const COPILOT_RUNTIME_URI = process.env.COPILOT_RUNTIME_URI?.trim() || undefined
const COPILOT_RUNTIME_TOKEN = process.env.COPILOT_RUNTIME_TOKEN?.trim() || undefined
const COPILOT_CLI_PATH = process.env.COPILOT_CLI_PATH?.trim() || undefined
const COPILOT_BASE_DIRECTORY = process.env.COPILOT_BASE_DIRECTORY?.trim() || undefined
const COPILOT_GITHUB_TOKEN = process.env.COPILOT_GITHUB_TOKEN?.trim()
  || process.env.GH_TOKEN?.trim()
  || process.env.GITHUB_TOKEN?.trim()
  || undefined
const COPILOT_INFINITE_SESSIONS = process.env.COPILOT_INFINITE_SESSIONS === '1'

interface CopilotProviderConfig extends Record<string, unknown> {
  type: 'openai' | 'azure'
  wireApi: 'completions' | 'responses'
  baseUrl: string
  apiKey?: string
  bearerToken?: string
  azure?: { apiVersion: string }
  modelId: string
  wireModel: string
}

interface CopilotSdkModule {
  CopilotClient: new (options?: Record<string, unknown>) => CopilotClientLike
  RuntimeConnection?: {
    forStdio?: (options?: { path?: string }) => unknown
    forUri?: (url: string, options?: Record<string, unknown>) => unknown
  }
}

interface CopilotClientLike {
  start: () => Promise<void>
  stop: () => Promise<Error[]>
  createSession: (config?: Record<string, unknown>) => Promise<CopilotSessionLike>
}

interface CopilotSessionLike {
  on: ((eventType: string, handler: (event: CopilotSessionEvent) => void) => () => void)
    & ((handler: (event: CopilotSessionEvent) => void) => () => void)
  send: (options: {
    prompt: string
    mode?: 'enqueue' | 'immediate'
    attachments?: Array<{ type: 'blob'; data: string; mimeType: string; displayName?: string }>
  }) => Promise<string>
  abort?: () => Promise<void>
  disconnect?: () => Promise<void>
  destroy?: () => Promise<void>
}

interface CopilotSessionEvent {
  type?: string
  data?: Record<string, unknown>
  error?: unknown
}

interface CopilotPermissionRequest extends Record<string, unknown> {
  kind?: string
  toolName?: string
  fileName?: string
  fullCommandText?: string
  managedApprovalRequired?: boolean
}

type CopilotPermissionResult =
  | { kind: 'approve-once' }
  | { kind: 'approve-for-session' }
  | { kind: 'reject'; feedback?: string }
  | { kind: 'no-result' }

type QueueItem =
  | { type: 'delta'; text: string }
  | { type: 'attachment'; attachment: MessageAttachment }
  | { type: 'done' }
  | { type: 'error'; error: unknown }

let clientPromise: Promise<CopilotClientLike> | null = null
let activeClient: CopilotClientLike | null = null

export function getCopilotModel(): string {
  return COPILOT_MODEL
}

export async function shutdownCopilotSDK(): Promise<void> {
  const client = activeClient
  activeClient = null
  clientPromise = null
  if (!client) return

  const errors = await client.stop()
  if (errors.length > 0) {
    throw new Error(errors.map(error => error.message).join('\n'))
  }
}

export async function* streamCopilotSDK(
  messages: Message[],
  options: CallOptions = {},
): AsyncGenerator<LLMStreamEvent, void, void> {
  const client = await getClient()
  const { systemMessage, prompt, attachments } = toCopilotInput(messages)
  const queue = new AsyncEventQueue<QueueItem>()
  const model = options.model ?? COPILOT_MODEL
  const provider = resolveCopilotProviderConfig(process.env, model)
  const session = await client.createSession({
    model,
    ...(provider ? { provider } : {}),
    streaming: true,
    workingDirectory: options.context?.cwd ?? options.context?.projectRoot ?? process.cwd(),
    infiniteSessions: { enabled: COPILOT_INFINITE_SESSIONS },
    onPermissionRequest: createPermissionHandler(options.context),
    ...(options.allowTools === false ? {} : { tools: [createCopilotImageTool(queue, options.signal)] }),
    ...(options.allowTools === false ? { availableTools: [] } : {}),
    ...(systemMessage ? { systemMessage: { content: systemMessage } } : {}),
  })

  const unsubs: Array<() => void> = []
  let finished = false
  let contentAcc = ''
  let finalContent = ''

  const finish = (item: QueueItem): void => {
    if (finished) return
    finished = true
    queue.push(item)
  }
  const pushDelta = (text: string): void => {
    if (finished || !text) return
    contentAcc += text
    queue.push({ type: 'delta', text })
  }

  unsubs.push(session.on('assistant.message_delta', event => {
    pushDelta(readEventText(event, 'deltaContent') ?? readEventText(event, 'content') ?? '')
  }))
  unsubs.push(session.on('assistant.message', event => {
    const content = readEventText(event, 'content')
    if (content) finalContent = content
  }))
  unsubs.push(session.on('session.idle', () => finish({ type: 'done' })))
  unsubs.push(session.on(event => {
    if (event.type === 'error' || event.type === 'session.error') {
      finish({ type: 'error', error: new Error(formatCopilotSDKError(event.error ?? event.data ?? event)) })
    }
  }))

  const abortHandler = (): void => {
    void session.abort?.().catch(() => {})
    finish({ type: 'error', error: new Error('Agent run was cancelled.') })
  }

  if (options.signal?.aborted) abortHandler()
  else options.signal?.addEventListener('abort', abortHandler, { once: true })

  void session.send({ prompt, attachments }).catch(error => {
    finish({ type: 'error', error: new Error(formatCopilotSDKError(error)) })
  })

  try {
    while (true) {
      const item = await queue.shift()
      if (item.type === 'delta') {
        yield { type: 'text_delta', text: item.text }
        continue
      }
      if (item.type === 'attachment') {
        yield { type: 'attachment', attachment: item.attachment }
        continue
      }
      if (item.type === 'error') throw item.error

      const text = finalContent || contentAcc
      const raw: Message = { role: 'assistant', content: text }
      const response: LLMResponse = { type: 'text', text, raw }
      yield { type: 'done', response }
      return
    }
  } finally {
    options.signal?.removeEventListener('abort', abortHandler)
    for (const unsub of unsubs) unsub()
    await disconnectSession(session)
  }
}

/**
 * Use Jesse Agent's existing LLM endpoint as a Copilot SDK BYOK provider when
 * no explicit GitHub token/runtime was configured. A GUI-launched macOS app
 * cannot rely on terminal-only `gh` auth, while its packaged .env is stable.
 */
export function resolveCopilotProviderConfig(
  env: NodeJS.ProcessEnv,
  modelId = env.COPILOT_MODEL?.trim() || 'gpt-5.6-sol',
): CopilotProviderConfig | undefined {
  if (env.LLM_API_MODE?.trim() !== 'copilot_sdk') return undefined
  if (env.COPILOT_RUNTIME_URI?.trim()) return undefined
  if (env.COPILOT_GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()) {
    return undefined
  }

  const configuredURL = env.LLM_BASE_URL?.trim()
  if (!configuredURL) return undefined

  let url: URL
  try {
    url = new URL(configuredURL)
  } catch {
    return undefined
  }

  const wireModel = env.LLM_MODEL?.trim() || modelId
  const wireApi = /\/responses(?:[/?]|$)/.test(url.pathname) ? 'responses' : 'completions'
  const azure = isAzureOpenAIHost(url.hostname)
  const apiKey = env.LLM_API_KEY?.trim()
  const keyHeader = env.LLM_API_KEY_HEADER?.trim().toLowerCase()
  const credential = apiKey
    ? (keyHeader === 'api-key' || azure ? { apiKey } : { bearerToken: apiKey })
    : {}

  if (azure) {
    return {
      type: 'azure',
      wireApi,
      baseUrl: url.origin,
      ...credential,
      azure: { apiVersion: url.searchParams.get('api-version') || '2024-10-21' },
      modelId,
      wireModel,
    }
  }

  return {
    type: 'openai',
    wireApi,
    baseUrl: providerBaseURL(url, wireApi),
    ...credential,
    modelId,
    wireModel,
  }
}

function isAzureOpenAIHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host.endsWith('.cognitiveservices.azure.com')
    || host.endsWith('.openai.azure.com')
    || host.endsWith('.services.ai.azure.com')
}

function providerBaseURL(url: URL, wireApi: 'completions' | 'responses'): string {
  const suffix = wireApi === 'responses' ? /\/responses\/?$/ : /\/chat\/completions\/?$/
  const pathname = url.pathname.replace(suffix, '').replace(/\/$/, '')
  return `${url.origin}${pathname}`
}

async function getClient(): Promise<CopilotClientLike> {
  if (!clientPromise) {
    clientPromise = startClient().catch(error => {
      clientPromise = null
      throw error
    })
  }
  return clientPromise
}

async function startClient(): Promise<CopilotClientLike> {
  const sdk = await loadCopilotSdk()
  const options: Record<string, unknown> = {}
  const useExternalRuntime = Boolean(COPILOT_RUNTIME_URI && sdk.RuntimeConnection?.forUri)
  const bundledCliPath = !useExternalRuntime && sdk.RuntimeConnection?.forStdio
    ? findCopilotCliPath()
    : undefined

  if (COPILOT_LOG_LEVEL) options.logLevel = COPILOT_LOG_LEVEL
  if (COPILOT_BASE_DIRECTORY) options.baseDirectory = resolve(COPILOT_BASE_DIRECTORY)
  if (bundledCliPath && sdk.RuntimeConnection?.forStdio) {
    options.connection = sdk.RuntimeConnection.forStdio({ path: bundledCliPath })
  }
  if (!useExternalRuntime && COPILOT_GITHUB_TOKEN) options.gitHubToken = COPILOT_GITHUB_TOKEN
  if (!useExternalRuntime && process.env.COPILOT_USE_LOGGED_IN_USER === '0') options.useLoggedInUser = false
  if (useExternalRuntime && COPILOT_RUNTIME_URI && sdk.RuntimeConnection?.forUri) {
    options.connection = sdk.RuntimeConnection.forUri(
      COPILOT_RUNTIME_URI,
      COPILOT_RUNTIME_TOKEN ? { connectionToken: COPILOT_RUNTIME_TOKEN } : undefined,
    )
  }

  const client = new sdk.CopilotClient(options)
  await client.start()
  activeClient = client
  return client
}

function findCopilotCliPath(): string | undefined {
  if (COPILOT_CLI_PATH) return resolve(COPILOT_CLI_PATH)

  for (const candidate of copilotCliCandidates()) {
    if (candidate && isExecutable(candidate)) return candidate
  }
  return undefined
}

function copilotCliCandidates(): string[] {
  const binaryName = process.platform === 'win32' ? 'copilot.exe' : 'copilot'
  const pathCandidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map(directory => resolve(directory, binaryName))

  return uniqueStrings([
    '/opt/homebrew/bin/copilot',
    '/usr/local/bin/copilot',
    ...pathCandidates,
    resolveOptionalPackagePath(`@github/copilot-${process.platform}-${process.arch}/copilot`),
    resolveOptionalPackagePath('@github/copilot/npm-loader.js'),
  ])
}

function resolveOptionalPackagePath(specifier: string): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return require.resolve(specifier)
  } catch {
    return undefined
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

async function loadCopilotSdk(): Promise<CopilotSdkModule> {
  const moduleName = '@github/copilot-sdk'
  try {
    return await import(moduleName) as CopilotSdkModule
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `无法加载 @github/copilot-sdk：${reason}\n请先运行 npm install @github/copilot-sdk，并确保当前 GitHub/Copilot 账号已登录或设置 COPILOT_GITHUB_TOKEN。`,
    )
  }
}

function toCopilotInput(messages: Message[]): {
  systemMessage?: string
  prompt: string
  attachments?: Array<{ type: 'blob'; data: string; mimeType: string; displayName?: string }>
} {
  const systemMessage = messages.find(message => message.role === 'system')?.content ?? undefined
  const conversation = messages.filter(message => message.role !== 'system')
  const latest = conversation.at(-1)
  const latestAttachments = latest?.role === 'user' ? toCopilotAttachments(latest.attachments) : undefined

  if (conversation.length === 1 && latest?.role === 'user') {
    return { systemMessage, prompt: latest.content ?? '', attachments: latestAttachments }
  }

  return {
    systemMessage,
    prompt: [
      'Continue this Jesse Agent conversation and answer the latest user request.',
      'The transcript below is previous context from Jesse Agent. Tool messages are historical tool results.',
      '',
      '<conversation_transcript>',
      ...conversation.map(formatCopilotTranscriptMessage),
      '</conversation_transcript>',
    ].join('\n'),
    attachments: latestAttachments,
  }
}

function toCopilotAttachments(attachments: MessageAttachment[] | undefined) {
  const values = (attachments ?? []).flatMap(attachment => {
    if (!attachment.dataURL) return []
    const parsed = parseImageDataURL(attachment.dataURL)
    return [{
      type: 'blob' as const,
      data: parsed.bytes.toString('base64'),
      mimeType: parsed.mimeType,
      displayName: attachment.name,
    }]
  })
  return values.length > 0 ? values : undefined
}

function createCopilotImageTool(queue: AsyncEventQueue<QueueItem>, signal?: AbortSignal): Record<string, unknown> {
  return {
    name: 'generate_image',
    description: [
      'Generate a new bitmap image from a detailed visual prompt.',
      'Use this whenever the user asks to create, draw, illustrate, or generate an image.',
      'The generated image is attached to the assistant message automatically.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Complete visual description for the generated image.' },
        size: {
          type: 'string',
          enum: ['1024x1024', '1024x1536', '1536x1024'],
          description: 'Image dimensions; use 1536x1024 by default.',
        },
      },
      required: ['prompt'],
    },
    skipPermission: true,
    defer: 'never',
    handler: async (rawArgs: unknown) => {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {}
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      const size = args.size === '1024x1024' || args.size === '1024x1536' || args.size === '1536x1024'
        ? args.size
        : '1536x1024'
      const generated = await generateImage({ prompt, size, signal })
      const parsed = parseImageDataURL(generated.dataURL)
      const attachment: MessageAttachment = {
        type: 'image',
        mimeType: parsed.mimeType,
        dataURL: parsed.dataURL,
        byteLength: parsed.bytes.length,
        name: 'Generated image.png',
        source: 'generated',
      }
      queue.push({ type: 'attachment', attachment })
      return {
        resultType: 'success',
        textResultForLlm: generated.revisedPrompt
          ? `Image generated and attached. Revised prompt: ${generated.revisedPrompt}`
          : 'Image generated successfully and attached to the assistant response.',
        binaryResultsForLlm: [{
          type: 'image',
          data: parsed.bytes.toString('base64'),
          mimeType: parsed.mimeType,
          description: attachment.name,
        }],
      }
    },
  }
}

function formatCopilotTranscriptMessage(message: Message, index: number): string {
  const lines = [`[${index}] ${message.role}:`]
  if (message.content) lines.push(message.content)
  if (message.tool_calls?.length) {
    lines.push('tool_calls:')
    for (const toolCall of message.tool_calls) {
      lines.push(`- ${toolCall.function.name}(${toolCall.function.arguments}) id=${toolCall.id}`)
    }
  }
  if (message.tool_call_id) lines.push(`tool_call_id=${message.tool_call_id}`)
  if (!message.content && !message.tool_calls?.length) lines.push('(empty)')
  return lines.join('\n')
}

function createPermissionHandler(context?: AgentRuntimeContext) {
  return async function onPermissionRequest(request: CopilotPermissionRequest): Promise<CopilotPermissionResult> {
    const normalized = normalizePermissionRequest(request)
    const mode = context?.permissionMode ?? getPermissionMode()

    const boundaryDecision = await permissionBoundaryDecision(normalized, request, context)
    if (boundaryDecision) return boundaryDecision

    if (mode === 'bypassPermissions') {
      console.log(`\n⚠️  ${permissionModeTitle(mode)} 模式：允许 Copilot SDK 操作。`)
      return { kind: 'approve-once' }
    }

    const modeDecision = permissionDecisionForMode(normalized, request, context)
    if (modeDecision) return modeDecision

    const decision = checkPermission(normalized.toolName, normalized.args, context?.permissionRules)
    if (!request.managedApprovalRequired && decision.behavior === 'allow') {
      if (decision.reason) console.log(`\n✅ ${decision.reason}`)
      return { kind: 'approve-once' }
    }
    if (decision.behavior === 'deny') {
      return { kind: 'reject', feedback: decision.reason ?? 'Permission denied.' }
    }

    const approvalRequest = buildCopilotApprovalRequest(normalized, request)
    const choice = context?.approvalHandler
      ? await context.approvalHandler(approvalRequest)
      : await confirm(approvalRequest.detail)

    if (choice === 'reject_once') {
      return { kind: 'reject', feedback: 'User rejected this Copilot SDK operation.' }
    }
    if (choice === 'allow_for_session') {
      const rule = rememberSessionAllowRule(normalized.toolName, normalized.args, context?.permissionRules)
      console.log(`✅ 已记住本次会话规则：${describeRule(rule)}`)
      return { kind: 'approve-for-session' }
    }
    return { kind: 'approve-once' }
  }
}

async function permissionBoundaryDecision(
  normalized: NormalizedPermissionRequest,
  request: CopilotPermissionRequest,
  context?: AgentRuntimeContext,
): Promise<CopilotPermissionResult | null> {
  if (!context) return null

  try {
    if (request.kind === 'write') {
      await resolveWritableToolPath(normalized.args.path, context)
    }
    if (request.kind === 'shell') {
      await resolveWorkingDirectory(normalized.args.cwd, context)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      kind: 'reject',
      feedback: `Workspace isolation blocked this operation: ${reason}`,
    }
  }
  return null
}

function permissionDecisionForMode(
  normalized: NormalizedPermissionRequest,
  request: CopilotPermissionRequest,
  context?: AgentRuntimeContext,
): CopilotPermissionResult | null {
  const mode = context?.permissionMode ?? getPermissionMode()

  if (mode === 'plan') {
    if (request.kind === 'read') return { kind: 'approve-once' }
    if (request.kind === 'shell') {
      const command = String(normalized.args.command ?? '')
      const classification = classifyBashCommand(command)
      if (classification.risk === 'read_only') return { kind: 'approve-once' }
    }
    return {
      kind: 'reject',
      feedback: `Plan 模式禁止执行会修改系统或不确定是否只读的 Copilot SDK 操作：${request.kind ?? normalized.toolName}。`,
    }
  }

  if (request.kind === 'read' && !request.managedApprovalRequired) return { kind: 'approve-once' }

  if (
    mode === 'acceptEdits' &&
    request.kind === 'write' &&
    !request.managedApprovalRequired &&
    isPathWithinProjectRoot(normalized.args.path, context)
  ) {
    console.log(`\n✅ ${permissionModeTitle(mode)} 模式：自动允许项目内 Copilot SDK 文件修改。`)
    return { kind: 'approve-once' }
  }

  return null
}

interface NormalizedPermissionRequest {
  toolName: string
  title: string
  detail: string
  args: Record<string, unknown>
  files?: string[]
}

function normalizePermissionRequest(request: CopilotPermissionRequest): NormalizedPermissionRequest {
  const kind = String(request.kind ?? 'unknown')
  if (kind === 'shell') {
    const command = String(request.fullCommandText ?? request.command ?? '')
    return {
      toolName: 'run_command',
      title: `Approve Copilot command: ${command}`,
      detail: [`Copilot SDK 请求执行命令：${command}`, `kind：${kind}`].join('\n'),
      args: { command, cwd: stringField(request, 'cwd') ?? '.' },
    }
  }

  if (kind === 'write') {
    const path = String(request.fileName ?? request.path ?? '')
    return {
      toolName: 'edit_file',
      title: `Approve Copilot file change: ${path}`,
      detail: [`Copilot SDK 请求修改文件：${path || '(unknown file)'}`, `kind：${kind}`].join('\n'),
      args: { path, copilotRequestKind: kind, operation: request.toolName ?? 'write' },
      files: path ? [path] : undefined,
    }
  }

  if (kind === 'read') {
    const path = String(request.fileName ?? request.path ?? '')
    return {
      toolName: 'read_file',
      title: `Approve Copilot read: ${path}`,
      detail: [`Copilot SDK 请求读取：${path || '(unknown target)'}`, `kind：${kind}`].join('\n'),
      args: { path, copilotRequestKind: kind },
      files: path ? [path] : undefined,
    }
  }

  const toolName = typeof request.toolName === 'string' && request.toolName.trim()
    ? request.toolName.trim()
    : `copilot_${kind}`
  return {
    toolName,
    title: `Approve Copilot ${kind}`,
    detail: [`Copilot SDK 请求执行操作：${toolName}`, `kind：${kind}`].join('\n'),
    args: compactPermissionArgs(request),
  }
}

function buildCopilotApprovalRequest(
  normalized: NormalizedPermissionRequest,
  request: CopilotPermissionRequest,
): ToolApprovalRequest {
  return {
    toolName: normalized.toolName,
    title: normalized.title,
    detail: [
      normalized.detail,
      request.managedApprovalRequired ? 'managedApprovalRequired：true' : '',
    ].filter(Boolean).join('\n'),
    args: normalized.args,
    files: normalized.files,
  }
}

function compactPermissionArgs(request: CopilotPermissionRequest): Record<string, unknown> {
  const entries = Object.entries(request)
    .filter(([key]) => !/token|authorization|secret|password/i.test(key))
    .slice(0, 20)
  return Object.fromEntries(entries.map(([key, value]) => [key, compactValue(value)]))
}

function compactValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 1_000) return `${value.slice(0, 1_000)}...`
  if (Array.isArray(value)) return value.slice(0, 20).map(compactValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 20)
      .map(([key, nested]) => [key, compactValue(nested)]),
  )
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.trim() ? field.trim() : undefined
}

function readEventText(event: CopilotSessionEvent, key: string): string | null {
  const value = event.data?.[key]
  return typeof value === 'string' ? value : null
}

export function formatCopilotSDKError(value: unknown): string {
  const detail = findCopilotErrorDetail(value)
  return detail.startsWith('GitHub Copilot') ? detail : `GitHub Copilot SDK: ${detail}`
}

function findCopilotErrorDetail(value: unknown, depth = 0): string {
  if (value instanceof Error && value.message.trim()) return value.message.trim()
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object' || depth > 3) return compactErrorValue(value)

  const record = value as Record<string, unknown>
  for (const key of ['message', 'reason', 'detail', 'error', 'data']) {
    if (!(key in record)) continue
    const candidate = findCopilotErrorDetail(record[key], depth + 1)
    if (candidate && candidate !== '[object Object]') return candidate
  }
  return compactErrorValue(value)
}

function compactErrorValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    if (serialized && serialized !== '{}') return serialized
  } catch {
    // Fall through to the generic description.
  }
  const fallback = String(value)
  return fallback === '[object Object]' ? 'Unknown error' : fallback
}

async function disconnectSession(session: CopilotSessionLike): Promise<void> {
  if (session.disconnect) {
    await session.disconnect()
    return
  }
  await session.destroy?.()
}

class AsyncEventQueue<T> {
  private values: T[] = []
  private waiters: Array<(value: T) => void> = []

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(value)
    else this.values.push(value)
  }

  shift(): Promise<T> {
    const value = this.values.shift()
    if (value) return Promise.resolve(value)
    return new Promise(resolve => this.waiters.push(resolve))
  }
}
