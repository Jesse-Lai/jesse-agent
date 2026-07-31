/**
 * contextBudget.ts —— 工具结果预算与上下文粗估（Phase 5 / Step 13）
 *
 * 解决什么问题：
 *   coding agent 很容易产生超大输出，比如测试日志、grep 结果、长文件内容。
 *   如果全部塞进 messages[]，模型上下文会被日志淹没。这里做两件事：
 *   1. 工具结果太长 → 完整内容落盘，只把预览 + 文件路径喂给模型。
 *   2. 上下文太长 → 先给用户警告，用户可以手动输入 /compact 压缩。
 *
 * 类比：不要把整箱资料塞上桌，只放摘要；整箱资料放后备箱，需要时再拿。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from './llm.js'

const TOOL_RESULT_DIR = '.jesse/tool-results'

const DEFAULT_TOOL_RESULT_MAX_CHARS = 12_000
const DEFAULT_CONTEXT_WARN_CHARS = 120_000

export const TOOL_RESULT_MAX_CHARS = numberFromEnv(
  'TOOL_RESULT_MAX_CHARS',
  DEFAULT_TOOL_RESULT_MAX_CHARS,
)

export const CONTEXT_WARN_CHARS = numberFromEnv(
  'CONTEXT_WARN_CHARS',
  DEFAULT_CONTEXT_WARN_CHARS,
)

export async function budgetToolResult(toolName: string, content: string): Promise<string> {
  if (content.length <= TOOL_RESULT_MAX_CHARS) return content

  await mkdir(TOOL_RESULT_DIR, { recursive: true })
  const filePath = join(TOOL_RESULT_DIR, `${createResultId(toolName)}.txt`)
  await writeFile(filePath, content, 'utf8')

  const previewBudget = Math.max(20, Math.floor(TOOL_RESULT_MAX_CHARS * 0.6))
  const headChars = Math.floor(previewBudget / 2)
  const tailChars = previewBudget - headChars
  const head = content.slice(0, headChars)
  const tail = content.slice(-tailChars)

  return [
    `工具 "${toolName}" 的结果过长（${content.length.toLocaleString()} 字符），完整内容已保存到：${filePath}`,
    `给模型的上下文只保留预览，避免撑爆上下文。`,
    '',
    '--- 结果开头预览 ---',
    head,
    '',
    '--- 结果结尾预览 ---',
    tail,
  ].join('\n')
}

export function estimateContextChars(messages: Message[]): number {
  // 真实 token 要靠模型返回 usage 或 tokenizer。当前先用字符数近似：简单、透明、够教学。
  return messages.reduce((sum, message) => {
    const contentSize = message.content?.length ?? 0
    const toolCallsSize = message.tool_calls ? JSON.stringify(message.tool_calls).length : 0
    const overhead = 50
    return sum + contentSize + toolCallsSize + overhead
  }, 0)
}

export function contextWarning(messages: Message[]): string | null {
  const chars = estimateContextChars(messages)
  if (chars < CONTEXT_WARN_CHARS) return null
  return [
    `当前上下文粗估约 ${chars.toLocaleString()} 字符，已超过警戒线 ${CONTEXT_WARN_CHARS.toLocaleString()} 字符。`,
    '建议输入 /compact 手动压缩；现在不会自动压缩。',
  ].join(' ')
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function createResultId(toolName: string): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z')
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${safeTool}-${suffix}`
}
