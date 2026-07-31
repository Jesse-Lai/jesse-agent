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
import { loadProjectMemoryContext } from './memory.js'
import { loadSkillsContext } from './skills.js'
import { loadMcpRuntimeContext, type McpRuntimeContext } from './mcp.js'
import { getPlanModeContext, initializePlanModeSession } from './planMode.js'
import { setExternalTools } from './tools/index.js'
import { openSession, SessionTranscript, type SessionEndReason } from './session.js'
import { compactMessages } from './compaction.js'
import { contextWarning, estimateContextChars } from './contextBudget.js'
import { stopAllRunningTasks } from './tasks.js'
import { getCurrentWorktreeSession, initializeWorktreeRuntime, restoreWorktreeSession } from './worktrees.js'
import { createCliRenderer } from './cliRenderer.js'
import {
  getPermissionMode,
  parsePermissionMode,
  permissionModeDescription,
  permissionModeHelp,
  permissionModeTitle,
  setPermissionMode,
} from './permissionMode.js'

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

const RESUME_SESSION = argValue('--resume')
const CONTINUE_SESSION = process.argv.includes('--continue')

let activeSession: SessionTranscript | null = null
let activeMcpRuntime: McpRuntimeContext | null = null
let activeMessageCount = 0
let sessionClosed = false
let mcpClosed = false

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

async function refreshSystemPrompt(messages: Message[]): Promise<void> {
  const first = messages[0]
  if (first?.role === 'system') {
    const [memory, skills] = await Promise.all([
      loadProjectMemoryContext(),
      loadSkillsContext(),
    ])
    first.content = buildSystemPrompt(
      memory,
      skills,
      activeMcpRuntime?.prompt ?? null,
      getPlanModeContext(),
    )
  }
}

async function handlePermissionModeCommand(input: string, messages: Message[]): Promise<void> {
  const directMode = input === '/plan'
    ? 'plan'
    : input === '/default'
      ? 'default'
      : input === '/acceptEdits'
        ? 'acceptEdits'
        : null

  const rawMode = directMode ?? input.slice('/mode'.length).trim()
  if (!rawMode) {
    console.log(`\n${permissionModeHelp()}\n`)
    return
  }

  const parsed = parsePermissionMode(rawMode)
  if (!parsed) {
    console.log(`\n未知权限模式：${rawMode}\n${permissionModeHelp()}\n`)
    return
  }

  const result = setPermissionMode(parsed)
  if (!result.ok) {
    console.log(`\n[mode] ${result.reason}\n`)
    return
  }

  await refreshSystemPrompt(messages)
  console.log(`\n[mode] 已切换到 ${permissionModeTitle(result.mode)}：${permissionModeDescription(result.mode)}\n`)
  if (result.mode === 'plan') {
    const planPath = getPlanModeContext().planFilePath
    if (planPath) console.log(`[plan] 计划文件：${planPath}\n`)
  }
}

async function recordNewMessages(
  session: SessionTranscript,
  messages: Message[],
  fromIndex: number,
): Promise<number> {
  for (let i = fromIndex; i < messages.length; i++) {
    const message = messages[i]
    if (!message) continue
    await session.appendMessage(i, message)
  }
  return messages.length
}

async function closeActiveSession(reason: SessionEndReason): Promise<void> {
  if (!activeSession || sessionClosed) return
  sessionClosed = true
  await activeSession.appendEnd(reason, activeMessageCount)
}

async function closeMcpRuntime(): Promise<void> {
  if (!activeMcpRuntime || mcpClosed) return
  mcpClosed = true
  await activeMcpRuntime.close()
}

async function shutdown(reason: SessionEndReason): Promise<void> {
  await stopAllRunningTasks()
  await closeActiveSession(reason)
  await closeMcpRuntime()
}

// ============================================================================
// 一、会话历史（内存缓存 + JSONL 行车记录仪）
// ============================================================================

// Phase 5 的决定：运行时仍然用 messages[] 当高速缓存；真正的来源是
// `.jesse/sessions/*.jsonl` 里的 append-only transcript。这样当前 loop 不用改，
// 但重启后可以从日志重建 messages。

// ============================================================================
// 二、REPL 主循环
// ============================================================================

async function main(): Promise<void> {
  const renderer = createCliRenderer({ verbose: VERBOSE })
  activeMcpRuntime = await loadMcpRuntimeContext()
  setExternalTools(activeMcpRuntime.tools)

  const openedSession = await openSession({
    resumeId: RESUME_SESSION,
    continueLatest: CONTINUE_SESSION,
    model: process.env.LLM_MODEL ?? 'gpt-4o-2024-11-20',
    apiMode: process.env.LLM_API_MODE ?? (process.env.LLM_BASE_URL?.includes('/responses') ? 'responses' : 'chat_completions'),
  })
  const session = openedSession.transcript
  activeSession = session
  initializePlanModeSession(session.id, event => session.appendPlanModeEvent(event))
  initializeWorktreeRuntime(session.id, event => session.appendWorktreeEvent(event))
  if (openedSession.worktreeSession) {
    try {
      await restoreWorktreeSession(openedSession.worktreeSession)
    } catch (err) {
      console.log(`[worktree] 恢复失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const messages: Message[] =
    openedSession.messages.length > 0
      ? openedSession.messages
      : [
          {
            role: 'system',
            content: buildSystemPrompt(null, null, activeMcpRuntime.prompt, getPlanModeContext()),
          },
        ]
  await refreshSystemPrompt(messages)
  let persistedMessageCount = openedSession.resumed ? messages.length : 0
  persistedMessageCount = await recordNewMessages(session, messages, persistedMessageCount)
  activeMessageCount = persistedMessageCount

  // readline 负责从终端一行一行读输入。question() 会打印提示符并等你敲回车。
  const rl = createInterface({ input: stdin, output: stdout })

  // 开场白 + 用法提示。具体终端排版交给 renderer，index.ts 保持 REPL 壳职责。
  const worktreeSession = getCurrentWorktreeSession()
  renderer.renderStartup({
    sessionId: session.id,
    modeTitle: permissionModeTitle(getPermissionMode()),
    mcpToolCount: activeMcpRuntime.prompt.toolCount,
    mcpServerCount: activeMcpRuntime.prompt.serverCount,
    mcpErrors: activeMcpRuntime.prompt.errors,
    worktreePath: worktreeSession?.worktreePath,
    resumedMessageCount: openedSession.resumed ? messages.length : undefined,
  })

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
      await shutdown('eof')
      break
    }

    // 空输入就跳过，重新等待。
    if (input === '') continue

    // 输入这两个词就退出。
    if (input === 'exit' || input === 'quit') {
      console.log('👋 再见！')
      await shutdown('exit')
      break
    }

    if (
      input === '/mode' ||
      input.startsWith('/mode ') ||
      input === '/plan' ||
      input === '/default' ||
      input === '/acceptEdits'
    ) {
      await handlePermissionModeCommand(input, messages)
      continue
    }

    if (input === '/compact') {
      console.log('\n[compact] 正在把旧上下文压缩成结构化工作纪要...')
      try {
        const result = await compactMessages(messages)
        if (!result.compacted) {
          console.log(`[compact] ${result.reason}\n`)
          continue
        }

        await session.appendCompactBoundary({
          beforeMessageCount: result.beforeMessageCount,
          afterMessageCount: result.afterMessageCount,
          compactedMessageCount: result.compactedMessageCount,
          keptRecentMessages: result.keptRecentMessages,
          summary: result.summary,
          messages: result.messages,
        })

        messages.splice(0, messages.length, ...result.messages)
        await refreshSystemPrompt(messages)
        persistedMessageCount = messages.length
        activeMessageCount = messages.length

        console.log(
          `[compact] 已压缩 ${result.compactedMessageCount} 条旧消息，保留最近 ${result.keptRecentMessages} 条原文。`,
        )
        console.log(
          `[compact] messages: ${result.beforeMessageCount} → ${result.afterMessageCount}，当前上下文粗估约 ${estimateContextChars(messages).toLocaleString()} 字符。\n`,
        )
      } catch (err) {
        console.log(`[compact] 压缩失败：${err instanceof Error ? err.message : String(err)}\n`)
      }
      continue
    }

    // 每轮用户输入前刷新动态 system prompt：权限模式、memory manifest、当前环境。
    await refreshSystemPrompt(messages)

    // 把用户这句话追加进历史（模型要看到完整上下文才能接话）。
    messages.push({ role: 'user', content: input })
    persistedMessageCount = await recordNewMessages(session, messages, persistedMessageCount)
    activeMessageCount = persistedMessageCount

    const warning = contextWarning(messages)
    if (warning) console.log(`\n[上下文提示] ${warning}\n`)

    // ---- Eval：交给 agentic loop，消费它吐出的事件流 ----
    // 核心与界面解耦：loop 只产生事件，index.ts（界面）负责把每种事件显示成
    // 终端文字。将来换成 Web/Mac，只需换这段显示逻辑，loop 一行不动。
    try {
      for await (const event of runAgent(messages, { refreshSystemPrompt })) {
        await session.appendEvent(event)
        persistedMessageCount = await recordNewMessages(session, messages, persistedMessageCount)
        activeMessageCount = persistedMessageCount
        renderer.renderEvent(event)
      }
      persistedMessageCount = await recordNewMessages(session, messages, persistedMessageCount)
      activeMessageCount = persistedMessageCount
    } catch (err) {
      console.error(`\n[出错] ${String(err)}\n`)
    } finally {
      renderer.stopThinking() // 兜底：无论正常结束还是异常，都别让指示器留着转
    }
    // ---- Loop：回到 while 顶部，继续等下一句 ----
  }

  await shutdown('exit')
  rl.close()
}

// ============================================================================
// 三、优雅退出：Ctrl+C
// ============================================================================

// 按 Ctrl+C 时，Node 会发一个 SIGINT 信号。我们拦下它，打个招呼再退出，
// 而不是粗暴地中断。
process.on('SIGINT', () => {
  console.log('\n👋 收到 Ctrl+C，再见！')
  void shutdown('sigint').finally(() => process.exit(0))
})

// 启动。用 main() 包一层，出错时能统一兜底。
main().catch(err => {
  console.error('致命错误：', err)
  void shutdown('fatal').finally(() => process.exit(1))
})
