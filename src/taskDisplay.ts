import type { TaskSnapshot } from './tasks.js'

export function formatTaskLine(task: TaskSnapshot): string {
  const parts = [
    `- ${task.id}`,
    `[${task.status}]`,
    task.kind,
    formatDuration(task.durationMs),
    formatBytes(task.outputBytes),
  ]
  const lines = [parts.join(' | ')]
  lines.push(`  description: ${task.description}`)
  if (task.command) lines.push(`  command: ${task.command}`)
  if (task.cwd) lines.push(`  cwd: ${task.cwd}`)
  if (task.continuationAvailable !== undefined) lines.push(`  continuation_available: ${task.continuationAvailable ? 'yes' : 'no'}`)
  if (task.transcriptPath) lines.push(`  transcript_path: ${task.transcriptPath}`)
  if (task.lastActivity) lines.push(`  last: ${task.lastActivity}`)
  lines.push(`  output_path: ${task.outputPath}`)
  if (task.exitCode !== undefined) lines.push(`  exit_code: ${task.exitCode}`)
  if (task.signal) lines.push(`  signal: ${task.signal}`)
  if (task.staleReason) lines.push(`  warning: ${task.staleReason}`)
  if (task.error) lines.push(`  error: ${task.error}`)
  return lines.join('\n')
}

export function formatTaskDetails(task: TaskSnapshot, retrievalStatus?: string): string {
  const lines = [
    retrievalStatus ? `retrieval_status: ${retrievalStatus}` : null,
    `task_id: ${task.id}`,
    `kind: ${task.kind}`,
    `status: ${task.status}`,
    `description: ${task.description}`,
    `duration: ${formatDuration(task.durationMs)}`,
    `output_size: ${formatBytes(task.outputBytes)}`,
    `output_path: ${task.outputPath}`,
  ].filter((line): line is string => Boolean(line))

  if (task.command) lines.push(`command: ${task.command}`)
  if (task.cwd) lines.push(`cwd: ${task.cwd}`)
  if (task.continuationAvailable !== undefined) lines.push(`continuation_available: ${task.continuationAvailable ? 'yes' : 'no'}`)
  if (task.transcriptPath) lines.push(`transcript_path: ${task.transcriptPath}`)
  if (task.lastActivity) lines.push(`last_activity: ${task.lastActivity}`)
  if (task.exitCode !== undefined) lines.push(`exit_code: ${task.exitCode}`)
  if (task.signal) lines.push(`signal: ${task.signal}`)
  if (task.staleReason) lines.push(`stale_warning: ${task.staleReason}`)
  if (task.error) lines.push(`error: ${task.error}`)
  return lines.join('\n')
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`
  const mib = kib / 1024
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`
}
