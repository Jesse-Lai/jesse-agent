/**
 * listFiles.ts —— 列目录工具（只读）
 *
 * 解决什么问题：让 agent 能查看一个目录下有哪些文件/子目录。
 * 对应 Claude Code：类似 GlobTool / ls 能力。我们的是极简版。
 */

import { readdir } from 'node:fs/promises'
import type { Tool } from '../types.js'

export const listFilesTool: Tool = {
  name: 'list_files',

  description:
    '列出一个目录下的文件和子目录。参数 path 传目录路径（不传则默认当前目录）。' +
    '返回该目录下的条目列表，目录名后带 / 以便区分。',

  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要列出的目录路径，默认当前目录 "."' },
    },
    // path 可选：不传就列当前目录。
  },

  // 只读：只是查看，不改动 → 权限检查放行。
  isReadOnly: true,

  async execute(args) {
    const path = String(args.path ?? '.')
    try {
      // withFileTypes: 拿到的每个条目能区分是文件还是目录。
      const entries = await readdir(path, { withFileTypes: true })
      if (entries.length === 0) return `目录 ${path} 为空`
      // 目录名后加 /，一眼能看出哪些是子目录。
      const lines = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      return lines.join('\n')
    } catch (err) {
      return `列目录失败：${String(err)}`
    }
  },
}
