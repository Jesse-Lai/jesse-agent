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
import { callLLM, type Message } from './llm.js'

// ============================================================================
// 一、对话历史（存在内存里）
// ============================================================================

// Phase 1 的决定：历史就是一个内存数组，退出即忘。
// "重启还记得" 是 Phase 5（持久化）的事，现在做属于跳步。
//
// 第一条 system 消息给模型设定身份。这是最简版，正式的系统提示是 Step 9。
const messages: Message[] = [
  {
    role: 'system',
    content: '你是 Jesse 的个人 AI 助手，用简洁友好的中文回答。',
  },
]

// ============================================================================
// 二、REPL 主循环
// ============================================================================

async function main(): Promise<void> {
  // readline 负责从终端一行一行读输入。question() 会打印提示符并等你敲回车。
  const rl = createInterface({ input: stdin, output: stdout })

  // 开场白 + 用法提示。
  console.log('🤖 Jesse-Agent（Phase 1：能对话）')
  console.log('   输入你的问题开始聊天；输入 exit 或按 Ctrl+C 退出。\n')

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

    // ---- Eval：问模型 ----
    try {
      const response = await callLLM(messages)

      // Phase 1 里模型只会走 'text' 分支（还没有工具）。
      // 'tool_calls' 分支等 Phase 3 接入 loop 后才会触发。
      if (response.type === 'text') {
        // ---- Print：打印回复 ----
        console.log(`\n助手 › ${response.text}\n`)
        // 把模型的回复也存进历史，这样下一轮它记得自己说过啥。
        messages.push(response.raw)
      } else {
        // 防御性提示：Phase 1 不该走到这里。
        console.log('\n[提示] 模型请求调用工具，但工具系统还没搭（Phase 2/3）。\n')
      }
    } catch (err) {
      // 单次调用失败不该让整个程序崩溃——报个错，继续下一轮。
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
