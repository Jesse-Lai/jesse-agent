/**
 * readFile.ts —— 读文件工具（只读）
 *
 * 解决什么问题：让 agent 能读取本地文件的内容。
 * 对应 Claude Code：src/tools/FileReadTool/。我们的是极简版。
 */

import { readFile as fsReadFile } from 'node:fs/promises'
import type { AgentRuntimeContext } from '../runtimeContext.js'
import type { Tool } from '../types.js'
import { rememberReadFile } from './readState.js'
import { resolveToolPath } from '../workingDirectory.js'

export const readFileTool: Tool = {
  name: 'read_file',

  // description 是给【模型】看的说明书。写清楚：能干什么、参数怎么给、有啥限制。
  // 这段文字决定模型用得对不对，是工具最重要的部分。
  description:
    '读取本地文件系统中一个文件的内容。参数 path 传文件路径（相对或绝对均可）。' +
    '可选 start_line 和 max_lines 用来读取大文件的局部行范围。只能读文件，不能读目录（读目录请用 list_files）。',

  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径' },
      start_line: { type: 'number', description: '可选。起始行号，1-based。省略则从文件开头读取。' },
      max_lines: { type: 'number', description: '可选。最多返回多少行。适合读取大文件局部片段。' },
    },
    required: ['path'],
  },

  // 只读：读文件不改动任何东西 → Step 6.5 权限检查会直接放行。
  isReadOnly: true,

  async execute(args, context?: AgentRuntimeContext) {
    const path = String(args.path ?? '')
    if (!path) return '错误：未提供 path 参数'
    try {
      const normalizedPath = resolveToolPath(path, context)
      const content = await fsReadFile(normalizedPath, 'utf-8')
      await rememberReadFile(normalizedPath, content, context)
      const ranged = applyLineRange(content, args.start_line, args.max_lines)
      if (ranged) return ranged
      // 返回文本结果。这段会被喂回给模型（Phase 3 的 loop）。
      return content
    } catch (err) {
      // 工具失败不抛异常，而是返回错误文本——让模型看到错误、自己决定下一步。
      // 这呼应第 1 层"工具结果（含错误）都喂回模型"的设计。
      return `读取文件失败：${String(err)}`
    }
  },
}

function applyLineRange(content: string, startLineInput: unknown, maxLinesInput: unknown): string | null {
  const startLine = normalizePositiveInteger(startLineInput)
  const maxLines = normalizePositiveInteger(maxLinesInput)
  if (!startLine && !maxLines) return null

  const lines = content.split('\n')
  const startIndex = Math.max(0, (startLine ?? 1) - 1)
  const endIndex = maxLines ? startIndex + maxLines : lines.length
  const selected = lines.slice(startIndex, endIndex)
  const endLine = startIndex + selected.length
  return [
    `--- ${startIndex + 1}-${endLine} / ${lines.length} lines ---`,
    selected.join('\n'),
    ...(endLine < lines.length ? [`--- ${lines.length - endLine} line(s) omitted ---`] : []),
  ].join('\n')
}

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}
