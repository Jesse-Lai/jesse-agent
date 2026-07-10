/**
 * index.ts —— agent 的"嘴和耳朵"（CLI 入口）
 *
 * 解决什么问题：
 *   Step 2 的 llm.ts 是"缸中之脑"——只能被单次调用。这个文件给它接上
 *   耳朵（读你的输入）和嘴巴（打印回复），让你能在终端里【连续对话】，
 *   而且模型记得上文。
 *
 * 它是一个 REPL 循环：
 *   Read（读输入）→ Eval（问模型）→ Print（打印）→ Loop（回到读输入）
 *
 * 对应 Claude Code：
 *   相当于 screens/REPL.tsx —— 最外层跟用户交互的壳。我们的是极简版：
 *   用 Node 内置 readline，不用 React/Ink。
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { Message } from './llm.js'
import { runAgent } from './loop.js'
import { buildSystemPrompt } from './prompt.js'

// ============================================================================
// 〇、可观测性开关（Step 8.5）：--verbose 或 DEBUG=1 打开"仪表盘"
// ============================================================================
//
// agentic loop 默认是黑盒——你只看到最终答案，看不到中间它"为什么选这个工具"。
// verbose 模式把每一轮的内部决策打印出来（第几轮、模型决定说话还是调工具、
// 结果如何），像给闷头转的引擎装块仪表盘。
//
// 两种打开方式（对应 PLAN Step 8.5 的 "--verbose / DEBUG 开关"）：
//   npm run dev -- --verbose      ← 命令行参数
//   DEBUG=1 npm run dev           ← 环境变量
//
// 承重原则的体现：所有日志都写在这里（事件消费方），loop 只负责 yield 事件、
// 一行都不打印。verbose 只是"把已有事件显示得更详细"，核心引擎毫不知情。
const VERBOSE =
  process.argv.includes('--verbose') || process.env.DEBUG === '1'

/** verbose 日志：只在开关打开时打印，用灰色 + [verbose] 前缀和正常输出区分。 */
function vlog(line: string): void {
  if (VERBOSE) console.log(`\x1b[90m  [verbose] ${line}\x1b[0m`)
}

// ============================================================================
// 一、对话历史（存在内存里）
// ============================================================================

// Phase 1 的决定：历史就是一个内存数组，退出即忘。
// "重启还记得" 是 Phase 5（持久化）的事，现在做属于跳步。
//
// 第一条 system 消息给模型设定身份和行为守则。Step 9 已把它抽到 prompt.ts，
// 结构参照 Claude Code（分段 + 静态/动态），启动时组装一次。
const messages: Message[] = [
  {
    role: 'system',
    content: buildSystemPrompt(),
  },
]

// ============================================================================
// 二、REPL 主循环
// ============================================================================

async function main(): Promise<void> {
  // readline 负责从终端一行一行读输入。question() 会打印提示符并等你敲回车。
  const rl = createInterface({ input: stdin, output: stdout })

  // 开场白 + 用法提示。
  console.log('🤖 Jesse-Agent（Phase 3：能自主调工具）')
  console.log('   输入你的问题开始聊天；输入 exit 或按 Ctrl+C 退出。')
  if (VERBOSE) console.log('   🔍 verbose 已开启：会打印每一轮的内部决策。')
  console.log()

  // 这就是 REPL 的 Loop：一个不断读输入的循环。
  while (true) {
    // ---- Read：读一行输入 ----
    // 当输入流结束时（管道喂完、或按 Ctrl+D），rl.question 会 reject。
    // 我们捕获它，把这种情况当作"用户想退出"，正常结束循环而不是崩溃。
    let input: string
    try {
      input = (await rl.question('你 › ')).trim()
    } catch {
      // readline 已关闭（EOF）——正常收尾。
      console.log('\n👋 输入结束，再见！')
      break
    }

    // 空输入就跳过，重新等待。
    if (input === '') continue

    // 输入这两个词就退出。
    if (input === 'exit' || input === 'quit') {
      console.log('👋 再见！')
      break
    }

    // 把用户这句话追加进历史（模型要看到完整上下文才能接话）。
    messages.push({ role: 'user', content: input })

    // ---- Eval：交给 agentic loop，消费它吐出的事件流 ----
    // 核心与界面解耦：loop 只产生事件，index.ts（界面）负责把每种事件显示成
    // 终端文字。将来换成 Web/Mac，只需换这段显示逻辑，loop 一行不动。
    try {
      for await (const event of runAgent(messages)) {
        switch (event.type) {
          case 'turn_start':
            // 仅 verbose：画一条轮次分隔线，让你看清 loop 转了几圈。
            vlog(`──────── 第 ${event.turn} 轮 ────────`)
            break
          case 'assistant_text':
            vlog('💬 模型决定：直接用文本回答 → 本轮对话结束')
            console.log(`\n助手 › ${event.text}\n`)
            break
          case 'tool_start':
            vlog(`🤔 模型决定：调用工具 ${event.name}，参数=${JSON.stringify(event.args)}`)
            console.log(`  🔧 调用工具 ${event.name}(${JSON.stringify(event.args)})`)
            break
          case 'tool_result': {
            const preview =
              event.content.length > 200
                ? event.content.slice(0, 200) + '…'
                : event.content
            console.log(`  ${event.ok ? '✓' : '✗'} ${preview}`)
            vlog(
              `📥 工具结果已回传给模型（${event.ok ? '成功' : '失败'}，共 ${event.content.length} 字），下一轮它会据此决策`,
            )
            break
          }
          case 'error':
            console.log(`\n[出错] ${event.reason}\n`)
            break
          case 'max_turns':
            console.log('\n[提示] 达到最大轮次，已强制结束本轮。\n')
            break
        }
      }
    } catch (err) {
      console.error(`\n[出错] ${String(err)}\n`)
    }
    // ---- Loop：回到 while 顶部，继续等下一句 ----
  }

  rl.close()
}

// ============================================================================
// 三、优雅退出：Ctrl+C
// ============================================================================

// 按 Ctrl+C 时，Node 会发一个 SIGINT 信号。我们拦下它，打个招呼再退出，
// 而不是粗暴地中断。
process.on('SIGINT', () => {
  console.log('\n👋 收到 Ctrl+C，再见！')
  process.exit(0)
})

// 启动。用 main() 包一层，出错时能统一兜底。
main().catch(err => {
  console.error('致命错误：', err)
  process.exit(1)
})
