/**
 * llm.ts —— agent 的"大脑接口"
 *
 * 解决什么问题：
 *   整个 agent 里，只有这个文件负责和大模型通信。别处（loop、CLI）想跟模型
 *   说话，都通过它。好处：所有"怎么发 HTTP、怎么重试、怎么解析"的细节集中在
 *   一处，以后换模型服务只改这里。
 *
 * 对应 Claude Code：
 *   相当于 QueryEngine.ts / services/api/ 那一层——真正调用模型 API 的地方。
 *   我们的是极简版：原生 fetch，无 SDK。
 */

// ============================================================================
// 一、类型定义：先把"消息长什么样""回复长什么样"用类型固定下来
// ============================================================================

/** 一条消息的角色。这是 OpenAI 对话格式的四种角色。 */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

/**
 * 模型"要求调用工具"时返回的结构。Phase 1 用不到，但先定义好，
 * 这样 Phase 3 写 loop 时不用改动这个文件。
 * 注意 arguments 是一个 JSON 字符串（不是对象），这是 OpenAI 的约定。
 */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * 一条对话消息。这是我们发给模型、也是模型回给我们的基本单位。
 * - content：文本内容（assistant 发起工具调用时可能为 null）
 * - tool_calls：只在 assistant 想调工具时出现
 * - tool_call_id：只在我们把"工具执行结果"回传给模型时出现（role='tool'）
 */
export interface Message {
  role: Role
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

/**
 * 工具的定义格式（发给模型，告诉它"你有哪些工具可用"）。
 * Phase 1 不传，Phase 2/3 才会用到。parameters 是一段 JSON Schema。
 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * callLLM 的返回值 —— 这就是我们上一步选的"前瞻式(方案A)"设计。
 *
 * 模型的回复本质只有两种：要么"说话"(text)，要么"要求调工具"(tool_calls)。
 * 用一个带 type 标签的联合类型表达这两种，Phase 1 只会走到 'text' 分支，
 * 但 'tool_calls' 分支已经备好，Phase 3 直接用。
 *
 * raw 字段：保留模型返回的原始 assistant 消息。loop 需要把它原样塞回对话
 * 历史（尤其带 tool_calls 时），所以这里一并交出去。
 */
export type LLMResponse =
  | { type: 'text'; text: string; raw: Message }
  | { type: 'tool_calls'; toolCalls: ToolCall[]; raw: Message }

/**
 * 流式版 streamLLM 一路吐出的内部事件：
 * - text_delta：一小段文本碎片（模型边生成边发）。
 * - done：流结束，附上拼好的完整回复（LLMResponse），供 loop 决策与存历史。
 */
export type LLMStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'done'; response: LLMResponse }

// ============================================================================
// 二、配置：从环境变量读网关地址和模型名，带默认值
// ============================================================================

// 用 ?? 提供默认值：即使没加载 .env，也能直接连本地网关。
// 以后换成真 OpenAI，只需改 .env，代码一行不动。
const BASE_URL = process.env.LLM_BASE_URL ?? 'http://localhost:4399/v1'
const MODEL = process.env.LLM_MODEL ?? 'gpt-4o-2024-11-20'
const API_KEY = process.env.LLM_API_KEY ?? '' // 本地网关不需要，留空即可
const API_MODE = process.env.LLM_API_MODE ?? (BASE_URL.includes('/responses') ? 'responses' : 'chat_completions')
const API_KEY_HEADER = process.env.LLM_API_KEY_HEADER ?? (BASE_URL.includes('cognitiveservices.azure.com') ? 'api-key' : 'Authorization')

// ============================================================================
// 三、核心函数：callLLM
// ============================================================================

export interface CallOptions {
  /** 可选的工具定义列表（Phase 2/3 使用）。 */
  tools?: ToolDefinition[]
  /** 可选的中断信号，用于取消请求（Ctrl+C 时会用到）。 */
  signal?: AbortSignal
}

export type LLMStreamer = (
  messages: Message[],
  options?: CallOptions,
) => AsyncGenerator<LLMStreamEvent, void, void>

/** 遇到限流(429)或服务端错误(5xx)时，最多重试几次。 */
const MAX_RETRIES = 3

/** 单次请求的超时（毫秒）。超过就中断这次尝试并触发重试，避免连接挂起时无限等待。 */
const REQUEST_TIMEOUT_MS = 60_000

/**
 * 把一段对话发给模型，【流式】拿回它的回复（Step 11）。
 *
 * 为什么是 async generator：我们的 loop 本身就是生成器，callLLM 也做成生成器后，
 * 两者天然咬合——文本碎片像水一样从这里流进 loop、再到界面，全程都是"事件"。
 *
 * @param messages 完整的对话历史（system/user/assistant/tool 混合）
 * @param options  可选：工具定义、中断信号
 * @yields         text_delta（文本碎片）…… 最后一个 done（完整回复）
 */
export async function* streamLLM(
  messages: Message[],
  options: CallOptions = {},
): AsyncGenerator<LLMStreamEvent, void, void> {
  if (API_MODE === 'responses') {
    yield* streamResponsesLLM(messages, options)
    return
  }

  // 组装请求体。stream:true = 让模型边生成边发（逐字），而不是全写完一次性给。
  // tools 只在传了的时候才加进去。
  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    stream: true,
  }
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools
  }

  // 重试循环：解决"网络抖动 / 被限流(429)"这类临时性失败。
  // 用指数退避（每次等待翻倍），避免在服务繁忙时火上浇油。
  let lastError: unknown
  // 一旦开始 yield 文本碎片就置 true：此后即使出错也不能重试（会重复输出）。
  let streamStarted = false
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 每次尝试都新建一个超时信号：到点自动中断这次 fetch。
      // 若调用方也传了信号（如 Ctrl+C），用 AbortSignal.any 合并——任一触发都中断。
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const requestSignal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal

      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      })

      // 429=被限流，5xx=服务端出错：这两类是"等一下也许就好了"，值得重试。
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`LLM 网关返回 ${response.status}`)
        await sleep(backoffMs(attempt))
        continue
      }

      // 其他非 2xx（如 400 参数错）：重试也没用，直接抛出。
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`LLM 请求失败 ${response.status}: ${text}`)
      }

      // 流式响应必须有可读的 body。
      if (!response.body) {
        throw new Error('LLM 流式响应没有 body')
      }

      // ---- 逐块读取 SSE 流 ----
      // 网关按 OpenAI 格式，每个事件是一行 `data: {json}`，最后以 `data: [DONE]` 收尾。
      // 文本碎片在 choices[0].delta.content；工具调用在 delta.tool_calls（也分块来）。
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = '' // 攒不完整的行：一个 data JSON 可能被网络切成两半到达。

      let contentAcc = '' // 拼完整文本
      const toolCallsAcc: ToolCall[] = [] // 按 index 拼完整工具调用

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        streamStarted = true
        buffer += decoder.decode(value, { stream: true })

        // 用换行切分；最后一段可能是半行，留到下一次拼。
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '' || payload === '[DONE]') continue

          let chunk: ChatCompletionChunk
          try {
            chunk = JSON.parse(payload)
          } catch {
            continue // 半行/杂行，跳过
          }
          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue

          // 文本碎片：累加 + 立刻吐给上层（逐字显示的关键）。
          if (delta.content) {
            contentAcc += delta.content
            yield { type: 'text_delta', text: delta.content }
          }
          // 工具调用碎片：默默拼齐，不逐字显示。
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) accumulateToolCall(toolCallsAcc, tc)
          }
        }
      }

      // 流读完 → 拼出完整的 assistant 消息 + LLMResponse，吐一个 done 收尾。
      const toolCalls = toolCallsAcc.filter(Boolean)
      const assistantMessage: Message = {
        role: 'assistant',
        content: contentAcc || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      }
      const finalResponse: LLMResponse =
        toolCalls.length > 0
          ? { type: 'tool_calls', toolCalls, raw: assistantMessage }
          : { type: 'text', text: contentAcc, raw: assistantMessage }
      yield { type: 'done', response: finalResponse }
      return
    } catch (err) {
      // 调用方主动取消（Ctrl+C，name='AbortError'）→ 别重试，直接抛出。
      if (err instanceof Error && err.name === 'AbortError') throw err
      // 已经开始吐文本碎片了 → 不能重试（会重复输出），直接抛给上层处理。
      if (streamStarted) throw err
      // 请求超时（name='TimeoutError'）或网络异常 → 临时故障，退避后重试。
      lastError = err
      await sleep(backoffMs(attempt))
    }
  }

  // 重试用尽仍失败。
  throw new Error(
    `streamLLM 在 ${MAX_RETRIES + 1} 次尝试后仍失败：${String(lastError)}`,
  )
}

/**
 * Azure/OpenAI Responses API 适配层。
 * 对外仍然吐我们自己的 LLMStreamEvent，这样 loop.ts 不需要跟着改。
 */
async function* streamResponsesLLM(
  messages: Message[],
  options: CallOptions = {},
): AsyncGenerator<LLMStreamEvent, void, void> {
  const body: Record<string, unknown> = {
    model: MODEL,
    ...toResponsesInput(messages),
    stream: true,
  }
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map(toResponsesTool)
  }

  let lastError: unknown
  let streamStarted = false
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const requestSignal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal

      const response = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      })

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`LLM 网关返回 ${response.status}`)
        await sleep(backoffMs(attempt))
        continue
      }

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`LLM 请求失败 ${response.status}: ${text}`)
      }

      if (!response.body) throw new Error('LLM 响应没有 body')

      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const responseJson = await response.json() as ResponsesResponse
        const finalResponse = toLLMResponseFromResponses(responseJson)
        if (finalResponse.type === 'text' && finalResponse.text) {
          yield { type: 'text_delta', text: finalResponse.text }
        }
        yield { type: 'done', response: finalResponse }
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let completed: ResponsesResponse | undefined

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        streamStarted = true
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '' || payload === '[DONE]') continue

          let event: ResponsesStreamEvent
          try {
            event = JSON.parse(payload)
          } catch {
            continue
          }

          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            yield { type: 'text_delta', text: event.delta }
          } else if (event.type === 'response.completed' && event.response) {
            completed = event.response
          } else if (event.type === 'error' || event.type === 'response.failed') {
            throw new Error(formatResponsesStreamError(event))
          }
        }
      }

      if (!completed) throw new Error('Responses API 流结束但没有 completed 事件')
      yield { type: 'done', response: toLLMResponseFromResponses(completed) }
      return
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      if (streamStarted) throw err
      lastError = err
      await sleep(backoffMs(attempt))
    }
  }

  throw new Error(
    `streamLLM 在 ${MAX_RETRIES + 1} 次尝试后仍失败：${String(lastError)}`,
  )
}

function authHeaders(): Record<string, string> {
  if (!API_KEY) return {}
  if (API_KEY_HEADER.toLowerCase() === 'api-key') return { 'api-key': API_KEY }
  return { [API_KEY_HEADER]: `Bearer ${API_KEY}` }
}

function toResponsesTool(tool: ToolDefinition): ResponsesToolDefinition {
  return {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }
}

function toResponsesInput(messages: Message[]): { instructions?: string; input: ResponsesInputItem[] } {
  const input: ResponsesInputItem[] = []
  let instructions: string | undefined

  for (const message of messages) {
    if (message.role === 'system' && !instructions) {
      instructions = message.content ?? ''
      continue
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: message.content ?? '',
      })
      continue
    }

    if (message.role === 'assistant' && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })
      }
      continue
    }

    input.push({ role: message.role, content: message.content ?? '' })
  }

  return instructions ? { instructions, input } : { input }
}

function toLLMResponseFromResponses(response: ResponsesResponse): LLMResponse {
  const toolCalls: ToolCall[] = []
  const textParts: string[] = []

  for (const item of response.output ?? []) {
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id ?? '',
        type: 'function',
        function: {
          name: item.name ?? '',
          arguments: item.arguments ?? '{}',
        },
      })
      continue
    }

    if (item.type === 'message') {
      for (const content of item.content ?? []) {
        if (content.type === 'output_text' && content.text) textParts.push(content.text)
      }
    }
  }

  if (toolCalls.length > 0) {
    return {
      type: 'tool_calls',
      toolCalls,
      raw: { role: 'assistant', content: textParts.join('') || null, tool_calls: toolCalls },
    }
  }

  const text = response.output_text ?? textParts.join('')
  return { type: 'text', text, raw: { role: 'assistant', content: text } }
}

// ============================================================================
// 四、内部小工具
// ============================================================================

/** 指数退避：第 0 次等 0.5s，第 1 次 1s，第 2 次 2s…… */
function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt
}

/** 一个返回 Promise 的 sleep，配合 await 使用。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 流式 chunk 里我们关心的部分（只声明用到的字段）。 */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: ToolCallDelta[]
    }
  }>
}

/** 工具调用的"碎片"：id/name 在第一块给，arguments 会分多块拼接。 */
interface ToolCallDelta {
  index?: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

interface ResponsesToolDefinition {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

type ResponsesInputItem =
  | { role: Role; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

interface ResponsesResponse {
  id?: string
  status?: string
  output_text?: string
  output?: ResponsesOutputItem[]
  error?: ResponsesError
  incomplete_details?: unknown
}

type ResponsesOutputItem =
  | {
      type: 'message'
      content?: Array<{ type?: string; text?: string }>
    }
  | {
      type: 'function_call'
      id?: string
      call_id?: string
      name?: string
      arguments?: string
    }

interface ResponsesStreamEvent {
  type?: string
  delta?: string
  response?: ResponsesResponse
  message?: string
  error?: ResponsesError
}

interface ResponsesError {
  code?: string
  message?: string
  type?: string
  param?: string
}

function formatResponsesStreamError(event: ResponsesStreamEvent): string {
  const error = event.error ?? event.response?.error
  const message = event.message ?? error?.message ?? 'Responses API 流式事件返回错误'
  const details = [
    error?.code,
    error?.type,
    error?.param,
    event.response?.status ? `status=${event.response.status}` : undefined,
    event.response?.id ? `response_id=${event.response.id}` : undefined,
    event.response?.incomplete_details ? `incomplete=${compactJson(event.response.incomplete_details, 400)}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  const hasSpecificMessage = Boolean(event.message || error?.message || error?.code || error?.type || error?.param)
  const prefix = details ? `${message} (${details})` : message
  return hasSpecificMessage ? prefix : `${prefix}: ${compactJson(event, 1_200)}`
}

function compactJson(value: unknown, maxChars: number): string {
  try {
    const text = JSON.stringify(value, redactSecretLikeFields)
    if (!text) return String(value)
    return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
  } catch {
    return String(value)
  }
}

function redactSecretLikeFields(key: string, value: unknown): unknown {
  if (/api[-_]?key|authorization|token|secret|password/i.test(key)) return '[redacted]'
  return value
}

/**
 * 把一块工具调用碎片拼进累加器（按 index 归位）。
 * 第一块带 id 和 name；后续块只带 arguments 的一部分，往后拼即可。
 */
function accumulateToolCall(acc: ToolCall[], delta: ToolCallDelta): void {
  const i = delta.index ?? 0
  let entry = acc[i]
  if (!entry) {
    entry = { id: delta.id ?? '', type: 'function', function: { name: '', arguments: '' } }
    acc[i] = entry
  }
  if (delta.id) entry.id = delta.id
  if (delta.function?.name) entry.function.name += delta.function.name
  if (delta.function?.arguments) entry.function.arguments += delta.function.arguments
}
