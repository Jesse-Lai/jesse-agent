/**
 * toolApprovals.ts - UI-facing approval request previews.
 *
 * CLI approvals can stay as y/a/n text, while IDE/desktop/IM frontends need a
 * structured request with the same safety decision plus a readable diff.
 */

import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import type { ConfirmChoice } from './confirm.js'
import type { AgentRuntimeContext } from './runtimeContext.js'
import { resolveToolPath } from './workingDirectory.js'

export interface ToolApprovalRequest {
  toolName: string
  title: string
  detail: string
  args: Record<string, unknown>
  files?: string[]
  diff?: string
  previewError?: string
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<ConfirmChoice>

const DIFF_CONTEXT_LINES = 3
const MAX_DIFF_CHARS = 24_000

export async function buildToolApprovalRequest(
  toolName: string,
  args: Record<string, unknown>,
  detail: string,
  context?: AgentRuntimeContext,
): Promise<ToolApprovalRequest> {
  const base: ToolApprovalRequest = {
    toolName,
    title: approvalTitle(toolName, args),
    detail,
    args: previewArgs(args),
  }

  if (toolName !== 'write_file' && toolName !== 'edit_file') return base

  const preview = await buildFileDiffPreview(toolName, args, context)
  return { ...base, ...preview }
}

async function buildFileDiffPreview(
  toolName: string,
  args: Record<string, unknown>,
  context?: AgentRuntimeContext,
): Promise<Pick<ToolApprovalRequest, 'files' | 'diff' | 'previewError'>> {
  const inputPath = String(args.path ?? '').trim()
  if (!inputPath) return { previewError: 'No file path was provided.' }

  const displayPath = displayToolPath(inputPath, context)
  const files = [displayPath]
  const absolutePath = resolveToolPath(inputPath, context)

  let current = ''
  let exists = false
  try {
    const info = await stat(absolutePath)
    if (info.isDirectory()) return { files, previewError: `${displayPath} is a directory, not a file.` }
    current = await readFile(absolutePath, 'utf8')
    exists = true
  } catch {
    exists = false
  }

  if (toolName === 'write_file') {
    const next = String(args.content ?? '')
    return { files, diff: createUnifiedDiff(displayPath, exists ? current : '', next) }
  }

  const oldString = String(args.old_string ?? '')
  const newString = String(args.new_string ?? '')
  const replaceAll = args.replace_all === true
  if (!exists) return { files, previewError: `${displayPath} does not exist, so edit_file cannot preview it.` }

  const matches = countOccurrences(current, oldString)
  if (matches === 0) return { files, previewError: 'old_string was not found in the current file.' }
  if (matches > 1 && !replaceAll) {
    return { files, previewError: `old_string matches ${matches} locations; set replace_all=true or provide more context.` }
  }

  const next = replaceAll ? current.replaceAll(oldString, newString) : current.replace(oldString, newString)
  return { files, diff: createUnifiedDiff(displayPath, current, next) }
}

function previewArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, previewValue(value)]),
  )
}

function previewValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= 1_000) return value
    return `${value.slice(0, 1_000)}... (${value.length.toLocaleString()} chars total)`
  }
  if (Array.isArray(value)) return value.map(previewValue)
  if (!value || typeof value !== 'object') return value
  return previewArgs(value as Record<string, unknown>)
}

function approvalTitle(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'write_file') return `Approve write_file: ${String(args.path ?? '')}`
  if (toolName === 'edit_file') return `Approve edit_file: ${String(args.path ?? '')}`
  if (typeof args.command === 'string') return `Approve command: ${args.command}`
  return `Approve ${toolName}`
}

function displayToolPath(inputPath: string, context?: AgentRuntimeContext): string {
  const root = context?.projectRoot
  if (!root) return inputPath
  const absolutePath = resolveToolPath(inputPath, context)
  const rel = relative(root, absolutePath)
  return rel && !rel.startsWith('..') ? rel : inputPath
}

function createUnifiedDiff(filePath: string, oldText: string, newText: string): string {
  if (oldText === newText) return `--- ${filePath}\n+++ ${filePath}\n(no content changes)`

  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const prefix = commonPrefixLength(oldLines, newLines)
  const suffix = commonSuffixLength(oldLines, newLines, prefix)

  const oldChangeEnd = oldLines.length - suffix
  const newChangeEnd = newLines.length - suffix
  const hunkOldStart = Math.max(0, prefix - DIFF_CONTEXT_LINES)
  const hunkNewStart = Math.max(0, prefix - DIFF_CONTEXT_LINES)
  const hunkOldEnd = Math.min(oldLines.length, oldChangeEnd + DIFF_CONTEXT_LINES)
  const hunkNewEnd = Math.min(newLines.length, newChangeEnd + DIFF_CONTEXT_LINES)

  const oldCount = Math.max(1, hunkOldEnd - hunkOldStart)
  const newCount = Math.max(1, hunkNewEnd - hunkNewStart)
  const lines = [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${hunkOldStart + 1},${oldCount} +${hunkNewStart + 1},${newCount} @@`,
  ]

  for (let index = hunkOldStart; index < prefix; index += 1) lines.push(` ${oldLines[index] ?? ''}`)
  for (let index = prefix; index < oldChangeEnd; index += 1) lines.push(`-${oldLines[index] ?? ''}`)
  for (let index = prefix; index < newChangeEnd; index += 1) lines.push(`+${newLines[index] ?? ''}`)
  for (let index = oldChangeEnd; index < hunkOldEnd; index += 1) lines.push(` ${oldLines[index] ?? ''}`)

  const diff = lines.join('\n')
  if (diff.length <= MAX_DIFF_CHARS) return diff
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n... diff truncated ...`
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

function commonPrefixLength(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a[index] === b[index]) index += 1
  return index
}

function commonSuffixLength(a: string[], b: string[], prefix: number): number {
  let count = 0
  while (
    count < a.length - prefix &&
    count < b.length - prefix &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  ) {
    count += 1
  }
  return count
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = 0
  while (true) {
    const next = content.indexOf(needle, index)
    if (next === -1) return count
    count += 1
    index = next + needle.length
  }
}
