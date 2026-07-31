export interface SimpleDiffOptions {
  filePath?: string
  contextLines?: number
  maxLines?: number
  color?: boolean
}

const DEFAULT_CONTEXT_LINES = 2
const DEFAULT_MAX_LINES = 36

export function formatSimpleDiff(
  oldContent: string,
  newContent: string,
  options: SimpleDiffOptions = {},
): string {
  if (oldContent === newContent) return '(no textual changes)'

  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)

  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldChangeEnd = oldLines.length - suffix
  const newChangeEnd = newLines.length - suffix
  const beforeStart = Math.max(0, prefix - contextLines)
  const afterOldStart = oldChangeEnd
  const afterOldEnd = Math.min(oldLines.length, afterOldStart + contextLines)

  const oldChanged = oldLines.slice(prefix, oldChangeEnd)
  const newChanged = newLines.slice(prefix, newChangeEnd)
  const before = oldLines.slice(beforeStart, prefix)
  const after = oldLines.slice(afterOldStart, afterOldEnd)

  const oldStart = prefix + 1
  const newStart = prefix + 1
  const oldCount = Math.max(1, oldChanged.length)
  const newCount = Math.max(1, newChanged.length)

  const lines: string[] = []
  if (options.filePath) {
    lines.push(`--- ${options.filePath}`)
    lines.push(`+++ ${options.filePath}`)
  }
  lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)

  for (const line of before) lines.push(formatLine(' ', line, options.color))
  for (const line of oldChanged) lines.push(formatLine('-', line, options.color))
  for (const line of newChanged) lines.push(formatLine('+', line, options.color))
  for (const line of after) lines.push(formatLine(' ', line, options.color))

  if (lines.length <= maxLines) return lines.join('\n')

  const keepHead = Math.max(1, Math.floor((maxLines - 1) / 2))
  const keepTail = Math.max(1, maxLines - 1 - keepHead)
  const omitted = lines.length - keepHead - keepTail
  return [
    ...lines.slice(0, keepHead),
    `... ${omitted} diff line(s) omitted ...`,
    ...lines.slice(-keepTail),
  ].join('\n')
}

function splitLines(content: string): string[] {
  if (content.length === 0) return []
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function formatLine(prefix: ' ' | '-' | '+', line: string, color = false): string {
  const text = `${prefix}${line}`
  if (!color) return text
  if (prefix === '-') return `\x1b[31m${text}\x1b[0m`
  if (prefix === '+') return `\x1b[32m${text}\x1b[0m`
  return `\x1b[90m${text}\x1b[0m`
}
