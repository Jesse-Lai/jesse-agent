/**
 * loop.ts —— agentic loop（agent 的灵魂）🔑
 *
 * 解决什么问题：
 *   把"大脑"（llm）和"手"（工具）连起来，让 agent 能【自己决定调工具】：
 *   问模型 → 模型要调工具就执行 → 结果塞回去 → 再问模型 → …… 直到模型
 *   给出最终文本答案。这就是"聊天机器人"和"agent"的分界线。
 *
 * 🔑 承重设计：写成 async generator（异步生成器），一路 yield 事件，
 *   自己【绝不 console.log】。谁调用它（现在是 CLI，将来是 Web/Mac）谁负责
 *   显示。好处：流式白送 + 核心与界面解耦，同一个 loop 能驱动任何界面。
 *
 * 对应 Claude Code：src/query.ts 的 queryLoop（同样是 async function* + while）。
 */

import { callLLM, type Message, type LLMResponse } from './llm.js'
import { allTools } from './tools/index.js'
import { executeTool } from './tools/executor.js'
import { toOpenAITools } from './types.js'

// 最大轮次保护：防止模型无限调工具、永不收尾（死循环）。
const MAX_TURNS = 10

/**
 * loop 向外吐出的"事件"。界面订阅这些事件来显示。
 * 用带 type 标签的联合类型，界面用 switch 分别处理。
 */
export type AgentEvent =
  | { type: 'turn_start'; turn: number }                  // 新一轮开始（第几次问模型）
  | { type: 'assistant_text'; text: string }              // 模型给出文本回复
  | { type: 'tool_start'; name: string; args: unknown }   // 开始执行某个工具
  | { type: 'tool_result'; name: string; ok: boolean; content: string } // 工具结果
  | { type: 'error'; reason: string }                     // 不可恢复错误（如 LLM 重试耗尽），优雅收尾
  | { type: 'max_turns' }                                 // 到达轮次上限，强制结束

/**
 * 运行一轮 agent 对话（一次用户提问 → 直到最终答复）。
 *
 * @param messages 对话历史（会被就地追加：assistant 回复、tool 结果）
 * @yields AgentEvent 事件流
 *
 * 注意：这是 generator，函数体不会立即执行；调用方用 `for await ... of`
 * 逐个取事件时，函数才一段段往下跑（每 yield 一次就交出一个事件）。
 */
export async function* runAgent(
  messages: Message[],
): AsyncGenerator<AgentEvent, void, void> {
  // 把我们的工具转成 OpenAI 格式，随每次请求发给模型，让它知道有哪些工具可用。
  const tools = toOpenAITools(allTools)

  // 轮次计数：每问一次模型算一轮。
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // ---- 0. 宣告"新一轮开始"（只吐事件，绝不打印）----
    // 为什么需要它：一轮里可能调多个工具，光看 tool_start/tool_result 事件，
    // 消费方分不清"同一轮的下一个工具"和"下一轮的第一个工具"（中间那次重新
    // 问模型是 loop 内部的事，界面看不见）。所以由 loop 显式吐出轮次边界。
    // turn 从 0 开始计数，给人看时 +1 更自然（"第 1 轮"）。
    yield { type: 'turn_start', turn: turn + 1 }

    // ---- 1. 问模型（带上工具清单）----
    // callLLM 内部已对超时/限流/网络异常重试。若仍彻底失败，它会抛异常。
    // 这里捕获它，转成 error 事件【优雅收尾】——和 max_turns 一样走"事件通道"，
    // 而不是把异常抛给界面。这维持了"loop 只通过事件对外沟通"的承重原则。
    let response: LLMResponse
    try {
      response = await callLLM(messages, { tools })
    } catch (err) {
      yield {
        type: 'error',
        reason: err instanceof Error ? err.message : String(err),
      }
      return // ← 出口3：不可恢复错误，优雅结束
    }

    // ---- 2. 模型给的是纯文本 → 本轮对话结束 ----
    if (response.type === 'text') {
      // 把模型的回复存进历史，下一轮它记得自己说过啥。
      messages.push(response.raw)
      // 吐出"文本回复"事件，然后返回（结束生成器）。
      yield { type: 'assistant_text', text: response.text }
      return // ← 出口1：正常结束
    }

    // ---- 3. 模型要求调工具 ----
    // 先把模型这条"我要调工具"的消息存进历史（OpenAI 要求：tool 结果之前
    // 必须先有带 tool_calls 的 assistant 消息，否则格式非法）。
    messages.push(response.raw)

    // 逐个执行模型要调的工具。
    for (const toolCall of response.toolCalls) {
      // arguments 是 JSON 字符串，先解析成对象。解析失败也不崩，给个空对象。
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(toolCall.function.arguments || '{}')
      } catch {
        args = {}
      }

      // 吐出"开始调工具"事件（界面可显示"正在执行 xxx…"）。
      yield { type: 'tool_start', name: toolCall.function.name, args }

      // 走 Phase 2 的三步管线执行（含 validate → 权限确认 → call）。
      const result = await executeTool(toolCall.function.name, args)

      // 吐出"工具结果"事件。
      yield {
        type: 'tool_result',
        name: toolCall.function.name,
        ok: result.ok,
        content: result.content,
      }

      // 把工具结果作为一条 role:'tool' 的消息塞回历史。
      // tool_call_id 必须对应上面那次 tool_call 的 id，模型才知道这是哪次调用的结果。
      messages.push({
        role: 'tool',
        content: result.content,
        tool_call_id: toolCall.id,
      })
    }

    // ---- 4. 回到 for 顶部，带着工具结果【再问一次模型】----
    // 模型这次能看到工具结果，据此决定：给最终答案，还是继续调工具。
  }

  // 循环跑满 MAX_TURNS 还没结束 → 强制收尾。
  yield { type: 'max_turns' } // ← 出口2：强制结束
}
