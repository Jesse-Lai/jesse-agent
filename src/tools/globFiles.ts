/**
 * globFiles.ts - find files by path/name pattern (read-only)
 *
 * This is the simplified version of Claude Code's GlobTool. It gives the model
 * a safe, structured way to find files without using shell commands directly.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool } from '../types.js'

const execFileAsync = promisify(execFile)

const DEFAULT_MAX_RESULTS = 100
const MAX_RESULTS_LIMIT = 500
const RG_TIMEOUT_MS = 30_000
const RG_MAX_BUFFER = 2 * 1024 * 1024

export const globFilesTool: Tool = {
  name: 'glob_files',

  description:
    '按 glob 模式查找文件路径。适合先定位可能相关的文件，例如 pattern="src/**/*.ts"。' +
    '参数 pattern 是文件路径匹配模式；path 是搜索目录，默认当前目录；max_results 限制返回数量。',

  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '文件路径 glob 模式，例如 "src/**/*.ts" 或 "**/*test*"' },
      path: { type: 'string', description: '搜索目录，默认当前目录 "."' },
      max_results: { type: 'number', description: `最多返回多少条结果，默认 ${DEFAULT_MAX_RESULTS}，上限 ${MAX_RESULTS_LIMIT}` },
    },
    required: ['pattern'],
  },

  isReadOnly: true,

  async execute(args) {
    const pattern = String(args.pattern ?? '').trim()
    if (!pattern) return '错误：未提供 pattern 参数'

    const path = String(args.path ?? '.').trim() || '.'
    const maxResults = normalizeMaxResults(args.max_results)

    try {
      const { stdout } = await execFileAsync(
        'rg',
        ['--files', '--glob', pattern, path],
        { timeout: RG_TIMEOUT_MS, maxBuffer: RG_MAX_BUFFER },
      )

      const files = stdout.split('\n').map(line => line.trim()).filter(Boolean)
      if (files.length === 0) return '未找到匹配文件。'

      const shown = files.slice(0, maxResults)
      const truncated = files.length > shown.length
      return [
        `找到 ${files.length} 个匹配文件${truncated ? `，显示前 ${shown.length} 个` : ''}：`,
        ...shown,
        ...(truncated ? ['结果已截断。请缩小 pattern/path，或提高 max_results。'] : []),
      ].join('\n')
    } catch (err) {
      const error = err as ExecFileError
      if (error.code === 1 && !error.stdout) return '未找到匹配文件。'
      if (error.code === 'ENOENT') return '执行失败：未找到 rg（ripgrep）。请先安装 ripgrep。'
      const stderr = error.stderr?.trim()
      return `查找文件失败：${stderr || error.message || String(err)}`
    }
  },
}

interface ExecFileError extends Error {
  code?: number | string | null
  stdout?: string
  stderr?: string
}

function normalizeMaxResults(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_RESULTS
  return Math.min(Math.floor(parsed), MAX_RESULTS_LIMIT)
}
