/**
 * confirm.ts —— 人工确认门（Human-in-the-Loop）🔒
 *
 * 解决什么问题：
 *   在执行【危险】工具（会改动系统的，如 run_command）之前，把要执行的动作
 *   打印出来，问用户 y/n。用户同意才放行，拒绝就挡下。这是 agent 的安全护栏。
 *
 * 对应 Claude Code：
 *   src/hooks/toolPermission/ 的确认交互。Claude Code 有 allow/deny/ask 等
 *   多种权限行为，我们先实现最核心的 "ask"（问 y/n）。
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

/**
 * 弹出一个 y/n 确认。
 *
 * @param message 要展示给用户的动作说明（比如"即将执行命令：rm foo"）
 * @returns       true = 用户同意；false = 用户拒绝
 *
 * 注意：这里每次临时开一个 readline。因为主 CLI（index.ts）也用 readline，
 * 为避免两者抢同一个输入流，这里用完即关。Phase 3 接入 loop 时如果发现
 * 冲突，会统一改为共享一个 readline 实例。
 */
export async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    // 打印动作 + 提示。默认给 N（更安全：不小心敲回车不会误执行）。
    const answer = (await rl.question(`\n⚠️  ${message}\n是否允许执行？(y/N) `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}
