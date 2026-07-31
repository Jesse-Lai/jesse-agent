/**
 * tasks.ts - lightweight background task registry.
 *
 * This is the small version of Claude Code's task layer. The registry supports
 * both shell processes and background sub-agents through the same task_id,
 * output, list, and stop surface.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveWorkingDirectory } from './workingDirectory.js'

const TASK_OUTPUT_DIR = '.jesse/task-output'
const DEFAULT_STALE_AFTER_MS = 30_000
const DEFAULT_STOP_GRACE_MS = 2_000
const DEFAULT_MAX_OUTPUT_CHARS = 20_000

export type TaskKind = 'shell' | 'agent'
export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

interface BaseTask {
  id: string
  kind: TaskKind
  description: string
  status: TaskStatus
  startTime: number
  endTime?: number
  outputPath: string
  outputBytes: number
  lastOutputAt: number
  lastActivity?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  error?: string
}

interface ShellTask extends BaseTask {
  kind: 'shell'
  command: string
  cwd: string
  process: ChildProcess
  outputStream: WriteStream
}

interface AgentTask extends BaseTask {
  kind: 'agent'
  abortController: AbortController
  outputStream: WriteStream
}

type OutputBackedTask = ShellTask | AgentTask
type BackgroundTask = ShellTask | AgentTask

export interface TaskSnapshot {
  id: string
  kind: TaskKind
  description: string
  status: TaskStatus
  startTime: string
  endTime?: string
  durationMs: number
  outputPath: string
  outputBytes: number
  lastOutputAt: string
  lastActivity?: string
  stale: boolean
  staleReason?: string
  command?: string
  cwd?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  error?: string
}

export interface StartShellTaskInput {
  command: string
  cwd?: unknown
  description?: string
}

export interface AgentTaskContext {
  taskId: string
  signal: AbortSignal
  write(chunk: string | Buffer): void
  updateActivity(activity: string): void
}

export interface StartAgentTaskInput {
  description?: string
  run: (context: AgentTaskContext) => Promise<void>
}

const tasks = new Map<string, BackgroundTask>()
let cleanupRegistered = false

export async function startShellTask(input: StartShellTaskInput): Promise<TaskSnapshot> {
  const command = input.command.trim()
  if (!command) throw new Error('command 不能为空')

  const resolvedCwd = await resolveWorkingDirectory(input.cwd)
  await mkdir(TASK_OUTPUT_DIR, { recursive: true })

  registerProcessCleanup()

  const id = createTaskId('shell')
  const outputPath = join(TASK_OUTPUT_DIR, `${id}.log`)
  const outputStream = createWriteStream(outputPath, { flags: 'a' })
  const child = spawn(command, {
    cwd: resolvedCwd.absolutePath,
    shell: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const now = Date.now()
  const task: ShellTask = {
    id,
    kind: 'shell',
    description: normalizeDescription(input.description, command),
    status: 'running',
    startTime: now,
    outputPath,
    outputBytes: 0,
    lastOutputAt: now,
    lastActivity: `started: ${command}`,
    command,
    cwd: resolvedCwd.displayPath,
    process: child,
    outputStream,
  }
  tasks.set(id, task)

  appendTaskOutput(task, `$ ${command}\n[cwd] ${resolvedCwd.displayPath}\n\n`)
  task.lastActivity = `started: ${command}`
  child.stdout.on('data', chunk => appendTaskOutput(task, chunk))
  child.stderr.on('data', chunk => appendTaskOutput(task, withChannelPrefix('stderr', chunk)))

  child.on('error', err => {
    task.status = 'failed'
    task.error = err.message
    task.endTime = Date.now()
    appendTaskOutput(task, `\n[task error] ${err.message}\n`)
    task.outputStream.end()
  })

  child.on('close', (code, signal) => {
    if (task.status !== 'stopped') {
      task.status = code === 0 ? 'completed' : 'failed'
      task.exitCode = code
      task.signal = signal
      task.endTime = Date.now()
    }

    const summary = task.status === 'stopped'
      ? '[task stopped]'
      : `[task finished] status=${task.status} exitCode=${code ?? 'null'} signal=${signal ?? 'null'}`
    appendTaskOutput(task, `\n${summary}\n`)
    task.outputStream.end()
  })

  return snapshotTask(task)
}

export async function startAgentTask(input: StartAgentTaskInput): Promise<TaskSnapshot> {
  await mkdir(TASK_OUTPUT_DIR, { recursive: true })
  registerProcessCleanup()

  const id = createTaskId('agent')
  const outputPath = join(TASK_OUTPUT_DIR, `${id}.log`)
  const outputStream = createWriteStream(outputPath, { flags: 'a' })
  const now = Date.now()
  const task: AgentTask = {
    id,
    kind: 'agent',
    description: normalizeDescription(input.description, 'background agent task'),
    status: 'running',
    startTime: now,
    outputPath,
    outputBytes: 0,
    lastOutputAt: now,
    lastActivity: 'started background agent',
    abortController: new AbortController(),
    outputStream,
  }
  tasks.set(id, task)

  appendTaskOutput(task, `[agent task started] ${task.description}\n\n`)
  void runAgentTask(task, input.run)

  return snapshotTask(task)
}

export function listTasks(): TaskSnapshot[] {
  return Array.from(tasks.values())
    .sort((a, b) => b.startTime - a.startTime)
    .map(snapshotTask)
}

export function getTask(taskId: string): TaskSnapshot | null {
  const task = tasks.get(taskId)
  return task ? snapshotTask(task) : null
}

export async function readTaskOutput(taskId: string, options: {
  block?: boolean
  timeoutMs?: number
  maxChars?: number
} = {}): Promise<{ snapshot: TaskSnapshot; output: string; retrievalStatus: 'success' | 'timeout' }> {
  const task = tasks.get(taskId)
  if (!task) throw new Error(`找不到 task：${taskId}`)

  if (options.block) await waitForTask(taskId, options.timeoutMs ?? 30_000)

  const latest = tasks.get(taskId) ?? task
  const timedOut = Boolean(options.block && latest.status === 'running')
  const output = await readTail(latest.outputPath, options.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS)

  return {
    snapshot: snapshotTask(latest),
    output,
    retrievalStatus: timedOut ? 'timeout' : 'success',
  }
}

export async function stopTask(taskId: string): Promise<TaskSnapshot> {
  const task = tasks.get(taskId)
  if (!task) throw new Error(`找不到 task：${taskId}`)
  if (task.status !== 'running') throw new Error(`task ${taskId} 当前不是 running，而是 ${task.status}`)

  task.status = 'stopped'
  task.endTime = Date.now()
  appendTaskOutput(task, '\n[task stop requested]\n')

  if (task.kind === 'agent') {
    task.abortController.abort()
    return snapshotTask(task)
  }

  task.process.kill('SIGTERM')
  setTimeout(() => {
    if (task.process.exitCode === null && task.process.signalCode === null) {
      task.process.kill('SIGKILL')
    }
  }, DEFAULT_STOP_GRACE_MS).unref()

  return snapshotTask(task)
}

export async function stopAllRunningTasks(): Promise<void> {
  await Promise.allSettled(
    Array.from(tasks.values())
      .filter(task => task.status === 'running')
      .map(task => stopTask(task.id)),
  )
}

function snapshotTask(task: BackgroundTask): TaskSnapshot {
  const now = Date.now()
  const staleMs = staleAfterMs()
  const silentForMs = now - task.lastOutputAt
  const stale = task.status === 'running' && silentForMs >= staleMs
  const snapshot: TaskSnapshot = {
    id: task.id,
    kind: task.kind,
    description: task.description,
    status: task.status,
    startTime: new Date(task.startTime).toISOString(),
    endTime: task.endTime ? new Date(task.endTime).toISOString() : undefined,
    durationMs: (task.endTime ?? now) - task.startTime,
    outputPath: task.outputPath,
    outputBytes: task.outputBytes,
    lastOutputAt: new Date(task.lastOutputAt).toISOString(),
    lastActivity: task.lastActivity,
    stale,
    staleReason: stale
      ? `任务仍在运行，但 ${Math.round(silentForMs / 1000)} 秒没有新输出；可能在等待输入、卡住，或只是安静运行。`
      : undefined,
    exitCode: task.exitCode,
    signal: task.signal,
    error: task.error,
  }

  if (task.kind === 'shell') {
    snapshot.command = task.command
    snapshot.cwd = task.cwd
  }

  return snapshot
}

function appendTaskOutput(task: OutputBackedTask, chunk: string | Buffer): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
  if (!text) return
  task.outputBytes += Buffer.byteLength(text)
  task.lastOutputAt = Date.now()
  task.lastActivity = lastMeaningfulLine(text) ?? task.lastActivity
  task.outputStream.write(text)
}

async function runAgentTask(
  task: AgentTask,
  run: (context: AgentTaskContext) => Promise<void>,
): Promise<void> {
  try {
    await run({
      taskId: task.id,
      signal: task.abortController.signal,
      write: chunk => appendTaskOutput(task, chunk),
      updateActivity: activity => {
        task.lastActivity = activity
        task.lastOutputAt = Date.now()
      },
    })

    if (task.status === 'running') {
      task.status = 'completed'
      task.endTime = Date.now()
      appendTaskOutput(task, '\n[task finished] status=completed\n')
    } else if (task.status === 'stopped') {
      appendTaskOutput(task, '\n[task finished] status=stopped\n')
    }
  } catch (err) {
    if (task.status === 'stopped' || task.abortController.signal.aborted) {
      task.status = 'stopped'
      task.endTime = task.endTime ?? Date.now()
      appendTaskOutput(task, '\n[task finished] status=stopped\n')
    } else {
      task.status = 'failed'
      task.error = err instanceof Error ? err.message : String(err)
      task.endTime = Date.now()
      appendTaskOutput(task, `\n[task error] ${task.error}\n`)
    }
  } finally {
    task.outputStream.end()
  }
}

function lastMeaningfulLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map(part => part.trim())
    .reverse()
    .find(Boolean)
  if (!line) return undefined
  return line.length <= 160 ? line : `${line.slice(0, 157)}...`
}

function withChannelPrefix(channel: string, chunk: string | Buffer): string {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
  if (!text) return ''
  return text
    .split(/(?<=\n)/)
    .map(part => (part.trim() ? `[${channel}] ${part}` : part))
    .join('')
}

async function waitForTask(taskId: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const task = tasks.get(taskId)
    if (!task || task.status !== 'running') return
    await sleep(100)
  }
}

async function readTail(filePath: string, maxChars: number): Promise<string> {
  const maxBytes = Math.max(1_000, maxChars * 4)
  let info
  try {
    info = await stat(filePath)
  } catch {
    return ''
  }

  const start = Math.max(0, info.size - maxBytes)
  const length = info.size - start
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const text = buffer.toString('utf8')
    return text.length > maxChars
      ? `[output truncated to last ${maxChars.toLocaleString()} chars]\n${text.slice(-maxChars)}`
      : text
  } finally {
    await handle.close()
  }
}

function normalizeDescription(description: unknown, command: string): string {
  if (typeof description === 'string' && description.trim()) return description.trim()
  return command.length <= 80 ? command : `${command.slice(0, 77)}...`
}

function staleAfterMs(): number {
  const raw = process.env.JESSE_TASK_STALE_MS
  const parsed = raw ? Number(raw) : DEFAULT_STALE_AFTER_MS
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_AFTER_MS
}

function createTaskId(kind: TaskKind): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z')
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${kind}-${stamp}-${suffix}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function registerProcessCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.once('exit', () => {
    for (const task of tasks.values()) {
      if (task.status === 'running' && task.kind === 'shell') {
        task.process.kill('SIGTERM')
      } else if (task.status === 'running' && task.kind === 'agent') {
        task.abortController.abort()
      }
    }
  })
}
