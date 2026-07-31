/**
 * session.ts —— 会话行车记录仪（Phase 5 / Step 12）
 *
 * 解决什么问题：
 *   以前对话只存在内存数组里，进程一关就消失。这里把每条关键记录追加到
 *   JSONL 文件：一行就是一条记录，只追加、不原地修改。这样以后崩溃或重启时，
 *   可以像看行车记录仪一样，从日志重建 messages。
 *
 * 对应 Claude Code：append-only transcript / session recovery 这一层。
 */

import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import type { Message } from './llm.js'
import type { AgentEvent } from './loop.js'
import type { WorktreeEventInput, WorktreeSession } from './worktrees.js'

const SESSION_DIR = '.jesse/sessions'

export type SessionEndReason = 'exit' | 'eof' | 'sigint' | 'fatal'

export type SessionRecord =
  | SessionStartRecord
  | SessionResumeRecord
  | MessageAppendedRecord
  | CompactBoundaryRecord
  | PlanModeEventRecord
  | WorktreeEventRecord
  | AgentEventRecord
  | SessionEndRecord

type SessionRecordPayload =
  | Omit<SessionStartRecord, keyof BaseRecord>
  | Omit<SessionResumeRecord, keyof BaseRecord>
  | Omit<MessageAppendedRecord, keyof BaseRecord>
  | Omit<CompactBoundaryRecord, keyof BaseRecord>
  | Omit<PlanModeEventRecord, keyof BaseRecord>
  | Omit<WorktreeEventRecord, keyof BaseRecord>
  | Omit<AgentEventRecord, keyof BaseRecord>
  | Omit<SessionEndRecord, keyof BaseRecord>

interface BaseRecord {
  timestamp: string
  sessionId: string
}

interface SessionStartRecord extends BaseRecord {
  type: 'session_start'
  cwd: string
  model: string
  apiMode: string
}

interface SessionResumeRecord extends BaseRecord {
  type: 'session_resume'
  cwd: string
}

interface MessageAppendedRecord extends BaseRecord {
  type: 'message_appended'
  index: number
  message: Message
}

interface CompactBoundaryRecord extends BaseRecord {
  type: 'compact_boundary'
  beforeMessageCount: number
  afterMessageCount: number
  compactedMessageCount: number
  keptRecentMessages: number
  summary: string
  messages: Message[]
}

export interface PlanModeEventInput {
  action: 'submitted' | 'approved' | 'rejected'
  filePath: string
  plan: string
  nextMode?: string
}

interface PlanModeEventRecord extends BaseRecord, PlanModeEventInput {
  type: 'plan_mode_event'
}

interface WorktreeEventRecord extends BaseRecord, WorktreeEventInput {
  type: 'worktree_event'
}

export interface CompactBoundaryInput {
  beforeMessageCount: number
  afterMessageCount: number
  compactedMessageCount: number
  keptRecentMessages: number
  summary: string
  messages: Message[]
}

interface AgentEventRecord extends BaseRecord {
  type: 'agent_event'
  event: Exclude<AgentEvent, { type: 'assistant_delta' }>
}

interface SessionEndRecord extends BaseRecord {
  type: 'session_end'
  reason: SessionEndReason
  messageCount: number
}

export interface OpenSessionOptions {
  resumeId?: string
  continueLatest: boolean
  model: string
  apiMode: string
}

export interface OpenedSession {
  transcript: SessionTranscript
  messages: Message[]
  worktreeSession: WorktreeSession | null
  resumed: boolean
}

export interface SessionSummary {
  id: string
  filePath: string
  updatedAt: string
  messageCount: number
  userMessageCount: number
  lastUserMessage: string | null
  compacted: boolean
  activeWorktreePath: string | null
}

/** 一个 JSONL 会话文件的轻量写入器。 */
export class SessionTranscript {
  constructor(
    readonly id: string,
    readonly filePath: string,
  ) {}

  async appendStart(model: string, apiMode: string): Promise<void> {
    await this.append({ type: 'session_start', cwd: cwd(), model, apiMode })
  }

  async appendResume(): Promise<void> {
    await this.append({ type: 'session_resume', cwd: cwd() })
  }

  async appendMessage(index: number, message: Message): Promise<void> {
    await this.append({ type: 'message_appended', index, message })
  }

  async appendCompactBoundary(input: CompactBoundaryInput): Promise<void> {
    await this.append({ type: 'compact_boundary', ...input })
  }

  async appendPlanModeEvent(input: PlanModeEventInput): Promise<void> {
    await this.append({ type: 'plan_mode_event', ...input })
  }

  async appendWorktreeEvent(input: WorktreeEventInput): Promise<void> {
    await this.append({ type: 'worktree_event', ...input })
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    // 每个 token delta 都写入会让日志爆炸；最终文本会通过 message_appended 保存。
    if (event.type === 'assistant_delta') return
    await this.append({ type: 'agent_event', event })
  }

  async appendEnd(reason: SessionEndReason, messageCount: number): Promise<void> {
    await this.append({ type: 'session_end', reason, messageCount })
  }

  private async append(record: SessionRecordPayload): Promise<void> {
    const fullRecord = {
      timestamp: new Date().toISOString(),
      sessionId: this.id,
      ...record,
    }
    await appendFile(this.filePath, JSON.stringify(fullRecord) + '\n', 'utf8')
  }
}

export async function openSession(options: OpenSessionOptions): Promise<OpenedSession> {
  await mkdir(SESSION_DIR, { recursive: true })

  if (options.resumeId && options.continueLatest) {
    throw new Error('不能同时使用 --resume 和 --continue')
  }

  if (options.resumeId || options.continueLatest) {
    const filePath = options.resumeId
      ? resolveSessionPath(options.resumeId)
      : await latestSessionPath()
    if (!filePath) throw new Error('没有可继续的历史 session')

    const id = sessionIdFromPath(filePath)
    const transcript = new SessionTranscript(id, filePath)
    const state = await loadSessionState(filePath)
    await transcript.appendResume()
    return { transcript, messages: state.messages, worktreeSession: state.worktreeSession, resumed: true }
  }

  const id = createSessionId()
  const filePath = join(SESSION_DIR, `${id}.jsonl`)
  const transcript = new SessionTranscript(id, filePath)
  await transcript.appendStart(options.model, options.apiMode)
  return { transcript, messages: [], worktreeSession: null, resumed: false }
}

export async function listSessionSummaries(limit = 12): Promise<SessionSummary[]> {
  if (!existsSync(SESSION_DIR)) return []

  const entries = await readdir(SESSION_DIR)
  const files = entries.filter(entry => entry.endsWith('.jsonl'))
  const summaries = await Promise.all(
    files.map(async file => {
      const filePath = join(SESSION_DIR, file)
      return await summarizeSession(filePath)
    }),
  )

  return summaries
    .filter((summary): summary is SessionSummary => summary !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, Math.max(1, limit))
}

export async function formatSessionList(limit = 12): Promise<string> {
  const sessions = await listSessionSummaries(limit)
  if (sessions.length === 0) return '没有找到历史 session。'

  const rows = sessions.map((session, index) => {
    const title = previewLine(session.lastUserMessage ?? '(no user message)', 70)
    const worktree = session.activeWorktreePath ? ` · worktree: ${session.activeWorktreePath}` : ''
    const compacted = session.compacted ? ' · compacted' : ''
    return [
      `${String(index + 1).padStart(2, ' ')}. ${formatLocalTime(session.updatedAt)}`,
      `    ${session.id}`,
      `    messages: ${session.messageCount}, user: ${session.userMessageCount}${compacted}${worktree}`,
      `    last: ${title}`,
      `    resume: npm run dev -- --resume ${session.id}`,
    ].join('\n')
  })

  return [
    `最近 ${sessions.length} 个 session：`,
    '',
    ...rows,
    '',
    '继续最近一次：npm run dev -- --continue',
  ].join('\n')
}

async function loadSessionState(filePath: string): Promise<{ messages: Message[]; worktreeSession: WorktreeSession | null }> {
  const raw = await readFile(filePath, 'utf8')
  const messages: Message[] = []
  let worktreeSession: WorktreeSession | null = null

  for (const [i, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue
    let record: SessionRecord
    try {
      record = JSON.parse(line) as SessionRecord
    } catch (err) {
      throw new Error(`Session 第 ${i + 1} 行不是合法 JSON：${String(err)}`)
    }
    if (record.type === 'message_appended') messages.push(record.message)
    if (record.type === 'compact_boundary') {
      messages.splice(0, messages.length, ...record.messages)
    }
    if (record.type === 'worktree_event') {
      worktreeSession = record.action === 'entered' ? record.session : null
    }
  }

  return { messages, worktreeSession }
}

async function summarizeSession(filePath: string): Promise<SessionSummary | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return null
  }

  const fileInfo = await stat(filePath)
  let messageCount = 0
  let userMessageCount = 0
  let lastUserMessage: string | null = null
  let compacted = false
  let updatedAt = fileInfo.mtime.toISOString()
  let activeWorktreePath: string | null = null

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue

    let record: SessionRecord
    try {
      record = JSON.parse(line) as SessionRecord
    } catch {
      continue
    }

    updatedAt = record.timestamp || updatedAt

    if (record.type === 'message_appended') {
      messageCount += 1
      if (record.message.role === 'user') {
        userMessageCount += 1
        lastUserMessage = record.message.content ?? null
      }
    }

    if (record.type === 'compact_boundary') {
      compacted = true
      messageCount = record.messages.length
      userMessageCount = record.messages.filter(message => message.role === 'user').length
      const lastUser = [...record.messages].reverse().find(message => message.role === 'user')
      lastUserMessage = lastUser?.content ?? lastUserMessage
    }

    if (record.type === 'worktree_event') {
      activeWorktreePath = record.action === 'entered' ? record.session?.worktreePath ?? null : null
    }
  }

  return {
    id: sessionIdFromPath(filePath),
    filePath,
    updatedAt,
    messageCount,
    userMessageCount,
    lastUserMessage,
    compacted,
    activeWorktreePath,
  }
}

function previewLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}...`
}

function formatLocalTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(' ')
}

function resolveSessionPath(idOrPath: string): string {
  if (idOrPath.includes('/') || idOrPath.endsWith('.jsonl')) return resolve(idOrPath)
  return resolve(join(SESSION_DIR, `${idOrPath}.jsonl`))
}

async function latestSessionPath(): Promise<string | undefined> {
  if (!existsSync(SESSION_DIR)) return undefined
  const entries = await readdir(SESSION_DIR)
  const files = entries.filter(entry => entry.endsWith('.jsonl'))
  const withTime = await Promise.all(
    files.map(async file => {
      const filePath = join(SESSION_DIR, file)
      return { filePath, mtimeMs: (await stat(filePath)).mtimeMs }
    }),
  )
  withTime.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return withTime[0]?.filePath
}

function sessionIdFromPath(filePath: string): string {
  const name = basename(filePath)
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name
}

function createSessionId(): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z')
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${suffix}`
}
