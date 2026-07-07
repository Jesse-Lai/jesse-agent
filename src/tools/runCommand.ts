/**
 * runCommand.ts —— 执行 shell 命令工具（⚠️ 危险，会改动系统）
 *
 * 解决什么问题：让 agent 能执行 shell 命令（如 ls、git status、npm test）。
 * 对应 Claude Code：src/tools/BashTool/。Claude Code 光是这个工具的"安全代码"
 *   就有 20 万字符（bashSecurity.ts + bashPermissions.ts），因为要防命令注入。
 *
 * ⚠️⚠️⚠️ 安全警告 ⚠️⚠️⚠️
 *   这个工具能执行【任意】命令，包括 rm -rf 这种破坏性操作。
 *   Step 5 里它是"裸奔"的——真正的护栏是 Step 6.5 的人工确认门（y/n）。
 *   在 Step 6.5 完成前，不要让模型自主调用它（Phase 3 才接入 loop）。
 *   这里只加两个【基础】保护：执行超时 + 输出截断。
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool } from '../types.js'

// 把回调式的 exec 包成 Promise 版，方便 await。
const execAsync = promisify(exec)

// 基础保护：命令最多跑 30 秒，避免卡死。
const TIMEOUT_MS = 30_000
// 基础保护：输出最多保留 1 万字符，避免超大输出撑爆上下文。
const MAX_OUTPUT_CHARS = 10_000

export const runCommandTool: Tool = {
  name: 'run_command',

  description:
    '在 shell 中执行一条命令，返回标准输出和标准错误。参数 command 传要执行的命令字符串。' +
    '适合运行如 ls、cat、git status、npm test 等命令。注意：这会真实地在系统上执行命令。',

  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
  },

  // ⚠️ 非只读：会真实改动系统 → Step 6.5 权限检查会【拦下来问用户 y/n】。
  isReadOnly: false,

  async execute(args) {
    const command = String(args.command ?? '')
    if (!command) return '错误：未提供 command 参数'
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB 缓冲上限
      })
      // 把标准输出和标准错误拼在一起返回（模型两个都想看到）。
      let output = stdout
      if (stderr) output += `\n[stderr]\n${stderr}`
      // 截断超长输出。
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + '\n...[输出过长已截断]'
      }
      return output.trim() || '（命令执行成功，无输出）'
    } catch (err) {
      // 命令失败（非零退出码、超时等）也返回文本，让模型看到错误。
      return `命令执行失败：${String(err)}`
    }
  },
}
