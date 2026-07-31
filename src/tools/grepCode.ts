/**
 * grepCode.ts - search code contents with ripgrep (read-only)
 *
 * This is the simplified version of Claude Code's GrepTool. It gives the model
 * a safe content-search tool and avoids using run_command for grep/rg searches.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool } from '../types.js'

const execFileAsync = promisify(execFile)

const DEFAULT_MAX_RESULTS = 100
const MAX_RESULTS_LIMIT = 500
const RG_TIMEOUT_MS = 30_000
const RG_MAX_BUFFER = 2 * 1024 * 1024

export const grepCodeTool: Tool = {
  name: 'grep_code',

  description:
    '用 ripgrep 搜索文件内容，返回匹配行。适合查找函数名、错误信息、变量名或代码片段。' +
    '参数 pattern 是正则或文本模式；path 是搜索目录/文件，默认当前目录；glob 可限制文件类型；max_results 限制返回数量。',

  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要搜索的文本或 ripgrep 正则模式，例如 "compactMessages"' },
      path: { type: 'string', description: '搜索目录或文件，默认当前目录 "."' },
      glob: { type: 'string', description: '可选文件过滤 glob，例如 "*.ts" 或 "*.{ts,tsx}"' },
      max_results: { type: 'number', description: `最多返回多少条匹配行，默认 ${DEFAULT_MAX_RESULTS}，上限 ${MAX_RESULTS_LIMIT}` },
      ignore_case: { type: 'boolean', description: '是否忽略大小写，默认 false' },
    },
    required: ['pattern'],
  },

  isReadOnly: true,

  async execute(args) {
    const pattern = String(args.pattern ?? '').trim()
    if (!pattern) return '错误：未提供 pattern 参数'

    const path = String(args.path ?? '.').trim() || '.'
    const glob = typeof args.glob === 'string' ? args.glob.trim() : ''
    const maxResults = normalizeMaxResults(args.max_results)
    const ignoreCase = args.ignore_case === true

    const rgArgs = [
      '--line-number',
      '--with-filename',
      '--no-heading',
      '--color',
      'never',
    ]
    if (ignoreCase) rgArgs.push('--ignore-case')
    if (glob) rgArgs.push('--glob', glob)
    rgArgs.push(pattern, path)

    try {
      const { stdout } = await execFileAsync('rg', rgArgs, {
        timeout: RG_TIMEOUT_MS,
        maxBuffer: RG_MAX_BUFFER,
      })

      return formatMatches(stdout, maxResults)
    } catch (err) {
      const error = err as ExecFileError
      if (error.code === 1) return '未找到匹配内容。'
      if (error.code === 'ENOENT') return '执行失败：未找到 rg（ripgrep）。请先安装 ripgrep。'
      const stdout = error.stdout?.trim()
      if (stdout) return formatMatches(stdout, maxResults)
      const stderr = error.stderr?.trim()
      return `搜索代码失败：${stderr || error.message || String(err)}`
    }
  },
}

interface ExecFileError extends Error {
  code?: number | string | null
  stdout?: string
  stderr?: string
}

function formatMatches(stdout: string, maxResults: number): string {
  const matches = stdout.split('\n').map(line => line.trimEnd()).filter(Boolean)
  if (matches.length === 0) return '未找到匹配内容。'

  const shown = matches.slice(0, maxResults)
  const truncated = matches.length > shown.length
  return [
    `找到 ${matches.length} 条匹配${truncated ? `，显示前 ${shown.length} 条` : ''}：`,
    ...shown,
    ...(truncated ? ['结果已截断。请缩小 pattern/path/glob，或提高 max_results。'] : []),
  ].join('\n')
}

function normalizeMaxResults(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_RESULTS
  return Math.min(Math.floor(parsed), MAX_RESULTS_LIMIT)
}
