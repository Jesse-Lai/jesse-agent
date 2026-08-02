/**
 * runCommand.ts —— 执行 shell 命令工具（⚠️ 危险，会改动系统）
 *
 * 解决什么问题：让 agent 能执行 shell 命令（如 ls、git status、npm test）。
 * 对应 Claude Code：src/tools/BashTool/。Claude Code 光是这个工具的"安全代码"
 *   就有 20 万字符（bashSecurity.ts + bashPermissions.ts），因为要防命令注入。
 *
 * ⚠️⚠️⚠️ 安全警告 ⚠️⚠️⚠️
 *   这个工具能执行【任意】命令，包括 rm -rf 这种破坏性操作。
 *   真正的护栏在 executor.ts 的 permission 阶段：先查权限规则，再问 y/a/n。
 *   这里只加两个【基础】保护：执行超时 + 1MB 进程缓冲上限。
 *   真正喂给模型的输出预算在 executor.ts 里统一处理。
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentRuntimeContext } from '../runtimeContext.js'
import type { Tool } from '../types.js'
import { resolveWorkingDirectory } from '../workingDirectory.js'

// 把回调式的 exec 包成 Promise 版，方便 await。
const execAsync = promisify(exec)

// 基础保护：命令最多跑 30 秒，避免卡死。
const TIMEOUT_MS = 30_000

export const runCommandTool: Tool = {
  name: 'run_command',

  description:
    '在 shell 中执行一条命令，返回标准输出和标准错误。参数 command 传要执行的命令字符串。 ' +
    '可选参数 cwd 指定执行目录，必须位于项目目录内，默认是项目根目录。 ' +
    '适合运行构建、测试、git status/git diff 等确实需要 shell 的命令。读取明确文件请优先用 read_file，不要用 cat/head/tail 代替。注意：这会真实地在系统上执行命令。',

  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      cwd: { type: 'string', description: '可选。命令执行目录，必须位于项目目录内；默认是项目根目录。' },
    },
    required: ['command'],
  },

  // ⚠️ 非只读：会真实改动系统 → permission 阶段会按规则放行、拒绝或问用户 y/a/n。
  isReadOnly: false,

  async execute(args, context?: AgentRuntimeContext) {
    const command = String(args.command ?? '')
    if (!command) return '错误：未提供 command 参数'
    try {
      const cwd = await resolveWorkingDirectory(args.cwd, context)
      const { stdout, stderr } = await execAsync(command, {
        cwd: cwd.absolutePath,
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB 缓冲上限
      })
      // 把标准输出和标准错误拼在一起返回（模型两个都想看到）。
      let output = stdout
      if (stderr) output += `\n[stderr]\n${stderr}`
      return output.trim() || `（命令执行成功，无输出；cwd=${cwd.displayPath}）`
    } catch (err) {
      // 命令失败（非零退出码、超时等）也返回文本，让模型看到错误。
      return `命令执行失败：${String(err)}`
    }
  },
}
