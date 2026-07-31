/**
 * editFile.ts - targeted string replacement for existing files
 *
 * Simplified Claude Code Edit tool:
 * - the file must be read first
 * - old_string must match exactly
 * - multiple matches are rejected unless replace_all=true
 */

import { writeFile } from 'node:fs/promises'
import type { AgentRuntimeContext } from '../runtimeContext.js'
import type { Tool } from '../types.js'
import { normalizeToolPath, refreshReadFile, requireFreshRead } from './readState.js'

export const editFileTool: Tool = {
  name: 'edit_file',

  description:
    '对已有文件做精确字符串替换。参数 path 是文件路径，old_string 是要替换的原文，new_string 是替换后的文本。' +
    '文件必须先用 read_file 读取过。默认 old_string 必须唯一匹配；如果要替换所有匹配，设置 replace_all=true。',

  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要编辑的文件路径' },
      old_string: { type: 'string', description: '要替换的原始文本，必须和文件内容精确匹配' },
      new_string: { type: 'string', description: '替换后的新文本' },
      replace_all: { type: 'boolean', description: '是否替换所有匹配项，默认 false' },
    },
    required: ['path', 'old_string', 'new_string'],
  },

  isReadOnly: false,

  async execute(args, context?: AgentRuntimeContext) {
    const path = String(args.path ?? '').trim()
    const oldString = String(args.old_string ?? '')
    const newString = String(args.new_string ?? '')
    const replaceAll = args.replace_all === true

    if (!path) return '错误：未提供 path 参数'
    if (oldString === newString) return '编辑被拒绝：old_string 和 new_string 完全相同。'

    const readCheck = await requireFreshRead(path, context)
    if (typeof readCheck === 'string') return `编辑被拒绝：${readCheck}`

    const content = readCheck.content
    const matches = countOccurrences(content, oldString)
    if (matches === 0) {
      return [
        '编辑被拒绝：old_string 在文件中没有找到。',
        '请先用 read_file 查看当前内容，并提供更准确的 old_string。',
      ].join('\n')
    }

    if (matches > 1 && !replaceAll) {
      return [
        `编辑被拒绝：old_string 在文件中出现了 ${matches} 次。`,
        '请提供更多上下文让 old_string 唯一匹配，或设置 replace_all=true。',
      ].join('\n')
    }

    const updated = replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString)

    try {
      const normalizedPath = normalizeToolPath(path, context)
      await writeFile(normalizedPath, updated, 'utf8')
      await refreshReadFile(normalizedPath, updated, context)

      const replaced = replaceAll ? matches : 1
      return [
        `编辑文件成功：${path}`,
        `替换 ${replaced} 处；字符数 ${content.length.toLocaleString()} → ${updated.length.toLocaleString()}。`,
      ].join('\n')
    } catch (err) {
      return `编辑文件失败：${String(err)}`
    }
  },
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = 0
  while (true) {
    const next = content.indexOf(needle, index)
    if (next === -1) return count
    count++
    index = next + needle.length
  }
}
