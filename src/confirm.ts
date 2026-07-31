/**
 * confirm.ts —— 人工确认门（Human-in-the-Loop）🔒
 *
 * 解决什么问题：
 *   在执行【危险】工具（会改动系统的，如 run_command）之前，把要执行的动作
 *   打印出来，让用户选择：允许一次、记住本次会话、或拒绝。这是 agent 的安全护栏。
 *
 * 对应 Claude Code：
 *   src/components/permissions/BashPermissionRequest/ 的确认交互。Claude Code 有
 *   Yes、Yes and don't ask again、No；我们先实现终端里的 y/a/n。
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

export type ConfirmChoice = 'allow_once' | 'allow_for_session' | 'reject_once'

/**
 * 弹出一个 y/a/n 确认。
 *
 * @param message 要展示给用户的动作说明（比如"即将执行命令：rm foo"）
 * @returns       allow_once = 允许一次；allow_for_session = 记住本次会话；reject_once = 拒绝
 *
 * 注意：这里每次临时开一个 readline。因为主 CLI（index.ts）也用 readline，
 * 为避免两者抢同一个输入流，这里用完即关。Phase 3 接入 loop 时如果发现
 * 冲突，会统一改为共享一个 readline 实例。
 */
export async function confirm(message: string): Promise<ConfirmChoice> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    // 打印动作 + 提示。默认给 N（更安全：不小心敲回车不会误执行）。
    const answer = (
      await rl.question(
        `\n⚠️  ${message}\n允许执行？y=允许一次，a=本次会话记住，n=拒绝 (y/a/N) `,
      )
    )
      .trim()
      .toLowerCase()

    if (answer === 'y' || answer === 'yes') return 'allow_once'
    if (answer === 'a' || answer === 'always') return 'allow_for_session'
    return 'reject_once'
  } finally {
    rl.close()
  }
}

export async function confirmYesNo(message: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await rl.question(`\n${message}\n确认？y=是，n=否 (y/N) `))
      .trim()
      .toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}
