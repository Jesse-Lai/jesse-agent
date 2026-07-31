/**
 * writeFile.ts - create or fully replace a file (write tool)
 *
 * Simplified Claude Code Write tool:
 * - new files can be created directly
 * - existing files must be read first
 * - if the file changed after the read, writing is rejected
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentRuntimeContext } from '../runtimeContext.js'
import type { Tool } from '../types.js'
import { normalizeToolPath, refreshReadFile, requireFreshRead } from './readState.js'

export const writeFileTool: Tool = {
  name: 'write_file',

  description:
    '创建新文件或完整覆盖一个已有文件。参数 path 是文件路径，content 是完整文件内容。' +
    '如果 path 已存在，必须先用 read_file 读取该文件，否则会拒绝写入。修改已有文件时优先使用 edit_file。',

  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要创建或覆盖的文件路径' },
      content: { type: 'string', description: '要写入文件的完整内容' },
    },
    required: ['path', 'content'],
  },

  isReadOnly: false,

  async execute(args, context?: AgentRuntimeContext) {
    const path = String(args.path ?? '').trim()
    const content = String(args.content ?? '')
    if (!path) return '错误：未提供 path 参数'

    const normalizedPath = normalizeToolPath(path, context)
    const existing = await existingFileKind(normalizedPath)
    if (existing === 'directory') return `写入失败：${path} 是目录，不是文件。`

    if (existing === 'file') {
      const readCheck = await requireFreshRead(path, context)
      if (typeof readCheck === 'string') return `写入被拒绝：${readCheck}`
    }

    try {
      await mkdir(dirname(normalizedPath), { recursive: true })
      await writeFile(normalizedPath, content, 'utf8')
      await refreshReadFile(normalizedPath, content, context)

      const action = existing === 'file' ? '覆盖' : '创建'
      return [
        `${action}文件成功：${path}`,
        `写入 ${content.length.toLocaleString()} 字符，${lineCount(content).toLocaleString()} 行。`,
      ].join('\n')
    } catch (err) {
      return `写入文件失败：${String(err)}`
    }
  },
}

async function existingFileKind(path: string): Promise<'file' | 'directory' | 'missing'> {
  try {
    const fileStat = await stat(path)
    if (fileStat.isDirectory()) return 'directory'
    return 'file'
  } catch {
    return 'missing'
  }
}

function lineCount(content: string): number {
  if (content.length === 0) return 0
  return content.split('\n').length
}
