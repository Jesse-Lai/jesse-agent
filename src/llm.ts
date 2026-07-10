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

// ============================================================================
// 二、配置：从环境变量读网关地址和模型名，带默认值
// ============================================================================

// 用 ?? 提供默认值：即使没加载 .env，也能直接连本地网关。
// 以后换成真 OpenAI，只需改 .env，代码一行不动。
const BASE_URL = process.env.LLM_BASE_URL ?? 'http://localhost:4399/v1'
const MODEL = process.env.LLM_MODEL ?? 'gpt-4o-2024-11-20'
const API_KEY = process.env.LLM_API_KEY ?? '' // 本地网关不需要，留空即可

// ============================================================================
// 三、核心函数：callLLM
// ============================================================================

export interface CallOptions {
  /** 可选的工具定义列表（Phase 2/3 使用）。 */
  tools?: ToolDefinition[]
  /** 可选的中断信号，用于取消请求（Ctrl+C 时会用到）。 */
  signal?: AbortSignal
}

/** 遇到限流(429)或服务端错误(5xx)时，最多重试几次。 */
const MAX_RETRIES = 3

/** 单次请求的超时（毫秒）。超过就中断这次尝试并触发重试，避免连接挂起时无限等待。 */
const REQUEST_TIMEOUT_MS = 60_000

/**
 * 把一段对话发给模型，拿回它的回复。
 *
 * @param messages 完整的对话历史（system/user/assistant/tool 混合）
 * @param options  可选：工具定义、中断信号
 * @returns        LLMResponse：'text' 或 'tool_calls'
 */
export async function callLLM(
  messages: Message[],
  options: CallOptions = {},
): Promise<LLMResponse> {
  // 组装请求体。stream:false 表示"等模型全部说完再一次性返回"（Phase 1 够用，
  // 逐字流式是 Step 11 的事）。tools 只在传了的时候才加进去。
  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    stream: false,
  }
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools
  }

  // 重试循环：解决"网络抖动 / 被限流(429)"这类临时性失败。
  // 用指数退避（每次等待翻倍），避免在服务繁忙时火上浇油。
  let lastError: unknown
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
          // 有 key 才加 Authorization 头；本地网关没有也无所谓。
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
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

      // 解析返回。网关是 OpenAI 兼容格式，回复在 choices[0].message。
      const data = (await response.json()) as ChatCompletionResponse
      const message = data.choices?.[0]?.message
      if (!message) {
        throw new Error('LLM 返回里没有 choices[0].message')
      }

      // 把原始返回翻译成我们的前瞻式 LLMResponse。
      const assistantMessage: Message = {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      }

      // 有 tool_calls → 模型想调工具；否则 → 模型在说话。
      if (message.tool_calls && message.tool_calls.length > 0) {
        return {
          type: 'tool_calls',
          toolCalls: message.tool_calls,
          raw: assistantMessage,
        }
      }
      return {
        type: 'text',
        text: message.content ?? '',
        raw: assistantMessage,
      }
    } catch (err) {
      // 调用方主动取消（Ctrl+C，name='AbortError'）→ 别重试，直接抛出。
      if (err instanceof Error && err.name === 'AbortError') throw err
      // 请求超时（name='TimeoutError'）或网络异常 → 临时故障，退避后重试。
      lastError = err
      await sleep(backoffMs(attempt))
    }
  }

  // 重试用尽仍失败。
  throw new Error(
    `callLLM 在 ${MAX_RETRIES + 1} 次尝试后仍失败：${String(lastError)}`,
  )
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

/** 网关返回体里我们关心的部分（只声明用到的字段）。 */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role: string
      content: string | null
      tool_calls?: ToolCall[]
    }
  }>
}
