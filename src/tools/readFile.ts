/**
 * readFile.ts —— 读文件工具（只读）
 *
 * 解决什么问题：让 agent 能读取本地文件的内容。
 * 对应 Claude Code：src/tools/FileReadTool/。我们的是极简版。
 */

import { readFile as fsReadFile } from 'node:fs/promises'
import type { Tool } from '../types.js'

export const readFileTool: Tool = {
  name: 'read_file',

  // description 是给【模型】看的说明书。写清楚：能干什么、参数怎么给、有啥限制。
  // 这段文字决定模型用得对不对，是工具最重要的部分。
  description:
    '读取本地文件系统中一个文件的内容。参数 path 传文件路径（相对或绝对均可）。' +
    '返回文件的纯文本内容。只能读文件，不能读目录（读目录请用 list_files）。',

  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径' },
    },
    required: ['path'],
  },

  // 只读：读文件不改动任何东西 → Step 6.5 权限检查会直接放行。
  isReadOnly: true,

  async execute(args) {
    const path = String(args.path ?? '')
    if (!path) return '错误：未提供 path 参数'
    try {
      const content = await fsReadFile(path, 'utf-8')
      // 返回文本结果。这段会被喂回给模型（Phase 3 的 loop）。
      return content
    } catch (err) {
      // 工具失败不抛异常，而是返回错误文本——让模型看到错误、自己决定下一步。
      // 这呼应第 1 层"工具结果（含错误）都喂回模型"的设计。
      return `读取文件失败：${String(err)}`
    }
  },
}
