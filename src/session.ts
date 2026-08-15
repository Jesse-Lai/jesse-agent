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

import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import type { Message } from './llm.js'
import type { AgentEvent } from './loop.js'
import {
  imageExtension,
  isValidAssetId,
  parseImageDataURL,
  persistedAttachment,
  type MessageAttachment,
} from './attachments.js'
import { sanitizeToolCallHistory } from './messageHistory.js'
import type { WorktreeEventInput, WorktreeSession } from './worktrees.js'
import type { SessionWorkspaceMetadata } from './workspaces.js'

const SESSION_DIR = '.jesse/sessions'

export type SessionEndReason = 'exit' | 'eof' | 'sigint' | 'fatal'

export type SessionRecord =
  | SessionStartRecord
  | SessionResumeRecord
  | SessionMetadataRecord
  | SessionRunStateRecord
  | MessageAppendedRecord
  | SessionTitleRecord
  | SessionArchiveRecord
  | CompactBoundaryRecord
  | PlanModeEventRecord
  | WorktreeEventRecord
  | AgentEventRecord
  | SessionEndRecord

type SessionRecordPayload =
  | Omit<SessionStartRecord, keyof BaseRecord>
  | Omit<SessionResumeRecord, keyof BaseRecord>
  | Omit<SessionMetadataRecord, keyof BaseRecord>
  | Omit<SessionRunStateRecord, keyof BaseRecord>
  | Omit<MessageAppendedRecord, keyof BaseRecord>
  | Omit<SessionTitleRecord, keyof BaseRecord>
  | Omit<SessionArchiveRecord, keyof BaseRecord>
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

export interface SessionSourceContext {
  app?: string
  bundleIdentifier?: string
  url?: string
  title?: string
}

export interface SessionMetadata {
  origin?: 'shortcut' | 'web' | 'mac' | 'ide' | 'routine'
  source?: SessionSourceContext
  executionRoot?: string
  workspace?: SessionWorkspaceMetadata
}

export type SessionRunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'

export interface SessionRunState {
  runId: string
  status: SessionRunStatus
  startedAt: string
  updatedAt: string
  finishedAt?: string
  error?: string
}

interface SessionMetadataRecord extends BaseRecord {
  type: 'session_metadata'
  metadata: SessionMetadata
}

interface SessionRunStateRecord extends BaseRecord {
  type: 'session_run_state'
  run: SessionRunState
}

interface MessageAppendedRecord extends BaseRecord {
  type: 'message_appended'
  index: number
  message: Message
}

interface SessionTitleRecord extends BaseRecord {
  type: 'session_title'
  title: string
  source: 'ai' | 'user'
}

interface SessionArchiveRecord extends BaseRecord {
  type: 'session_archive'
  archived: boolean
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
  title: string | null
  metadata: SessionMetadata
  lastRun: SessionRunState | null
  resumed: boolean
}

export interface SessionView {
  id: string
  title: string | null
  messages: Message[]
  metadata: SessionMetadata
  lastRun: SessionRunState | null
}

export interface SessionSummary {
  id: string
  title: string
  filePath: string
  updatedAt: string
  messageCount: number
  userMessageCount: number
  firstUserMessage: string | null
  lastUserMessage: string | null
  hasPersistedTitle: boolean
  compacted: boolean
  activeWorktreePath: string | null
  archived: boolean
  metadata: SessionMetadata
  lastRun: SessionRunState | null
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

  async appendMetadata(metadata: SessionMetadata): Promise<void> {
    await this.append({ type: 'session_metadata', metadata })
  }

  async appendRunState(run: SessionRunState): Promise<void> {
    await this.append({ type: 'session_run_state', run })
  }

  async appendMessage(index: number, message: Message): Promise<void> {
    await persistInlineAttachments(message, this.filePath)
    await this.append({ type: 'message_appended', index, message: messageForTranscript(message) })
  }

  async appendTitle(title: string, source: 'ai' | 'user' = 'ai'): Promise<void> {
    await this.append({ type: 'session_title', title, source })
  }

  async appendArchive(archived: boolean): Promise<void> {
    await this.append({ type: 'session_archive', archived })
  }

  async appendCompactBoundary(input: CompactBoundaryInput): Promise<void> {
    await Promise.all(input.messages.map(message => persistInlineAttachments(message, this.filePath)))
    await this.append({
      type: 'compact_boundary',
      ...input,
      messages: input.messages.map(messageForTranscript),
    })
  }

  async appendPlanModeEvent(input: PlanModeEventInput): Promise<void> {
    await this.append({ type: 'plan_mode_event', ...input })
  }

  async appendWorktreeEvent(input: WorktreeEventInput): Promise<void> {
    await this.append({ type: 'worktree_event', ...input })
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    // 每个 token delta 都写入会让日志爆炸；最终文本会通过 message_appended 保存。
    if (event.type === 'assistant_delta' || event.type === 'assistant_attachment') return
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
  await mkdir(sessionDir(), { recursive: true })

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
    return {
      transcript,
      messages: state.messages,
      worktreeSession: state.worktreeSession,
      title: state.title,
      metadata: state.metadata,
      lastRun: state.lastRun,
      resumed: true,
    }
  }

  const id = createSessionId()
  const filePath = join(sessionDir(), `${id}.jsonl`)
  const transcript = new SessionTranscript(id, filePath)
  await transcript.appendStart(options.model, options.apiMode)
  return {
    transcript,
    messages: [],
    worktreeSession: null,
    title: null,
    metadata: {},
    lastRun: null,
    resumed: false,
  }
}

export async function readSessionView(idOrPath: string, root = cwd()): Promise<SessionView> {
  const filePath = resolveSessionPath(idOrPath, root)
  const state = await loadSessionState(filePath)
  return {
    id: sessionIdFromPath(filePath),
    title: state.title,
    messages: state.messages,
    metadata: state.metadata,
    lastRun: state.lastRun,
  }
}

export async function appendSessionTitle(idOrPath: string, title: string, root = cwd()): Promise<void> {
  const filePath = resolveSessionPath(idOrPath, root)
  const transcript = new SessionTranscript(sessionIdFromPath(filePath), filePath)
  await transcript.appendTitle(title, 'user')
}

export async function appendSessionArchive(idOrPath: string, archived = true, root = cwd()): Promise<void> {
  const filePath = resolveSessionPath(idOrPath, root)
  const transcript = new SessionTranscript(sessionIdFromPath(filePath), filePath)
  await transcript.appendArchive(archived)
}

export async function markSessionRunInterrupted(
  idOrPath: string,
  root = cwd(),
  reason = 'Run was interrupted because the local Jesse Agent service restarted.',
): Promise<SessionRunState | null> {
  const filePath = resolveSessionPath(idOrPath, root)
  const state = await loadSessionState(filePath)
  const run = state.lastRun
  if (!run || !isActiveRunStatus(run.status)) return run

  const now = new Date().toISOString()
  const interrupted: SessionRunState = {
    ...run,
    status: 'failed',
    updatedAt: now,
    finishedAt: now,
    error: reason,
  }
  const transcript = new SessionTranscript(sessionIdFromPath(filePath), filePath)
  await transcript.appendRunState(interrupted)
  return interrupted
}

export async function listSessionSummaries(limit = 12, root = cwd()): Promise<SessionSummary[]> {
  const dir = sessionDir(root)
  if (!existsSync(dir)) return []

  const entries = await readdir(dir)
  const files = entries.filter(entry => entry.endsWith('.jsonl'))
  const summaries = await Promise.all(
    files.map(async file => {
      const filePath = join(dir, file)
      return await summarizeSession(filePath)
    }),
  )

  return summaries
    .filter((summary): summary is SessionSummary => summary !== null)
    .filter(summary => summary.userMessageCount > 0)
    .filter(summary => !summary.archived)
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

async function loadSessionState(filePath: string): Promise<{
  messages: Message[]
  worktreeSession: WorktreeSession | null
  title: string | null
  metadata: SessionMetadata
  lastRun: SessionRunState | null
}> {
  const raw = await readFile(filePath, 'utf8')
  const messages: Message[] = []
  let worktreeSession: WorktreeSession | null = null
  let aiTitle: string | null = null
  let userTitle: string | null = null
  let metadata: SessionMetadata = {}
  let lastRun: SessionRunState | null = null

  for (const [i, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue
    let record: SessionRecord
    try {
      record = JSON.parse(line) as SessionRecord
    } catch (err) {
      throw new Error(`Session 第 ${i + 1} 行不是合法 JSON：${String(err)}`)
    }
    if (record.type === 'message_appended') messages.push(record.message)
    if (record.type === 'session_metadata') {
      metadata = mergeSessionMetadata(metadata, record.metadata)
    }
    if (record.type === 'session_run_state') lastRun = record.run
    if (record.type === 'session_title') {
      if (record.source === 'user') userTitle = record.title
      else aiTitle = record.title
    }
    if (record.type === 'compact_boundary') {
      messages.splice(0, messages.length, ...record.messages)
    }
    if (record.type === 'worktree_event') {
      worktreeSession = record.action === 'entered' ? record.session : null
    }
  }

  await Promise.all(messages.map(message => hydrateMessageAttachments(message, filePath)))

  return {
    messages: sanitizeToolCallHistory(messages),
    worktreeSession,
    title: userTitle ?? aiTitle,
    metadata,
    lastRun,
  }
}

export function resolveSessionAssetPath(sessionId: string, assetId: string, root = cwd()): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(sessionId)) throw new Error('invalid session id')
  if (!isValidAssetId(assetId)) throw new Error('invalid session asset id')
  return join(sessionDir(root), `${sessionId}.assets`, assetId)
}

function sessionAssetDirectory(filePath: string): string {
  return join(dirname(filePath), `${sessionIdFromPath(filePath)}.assets`)
}

async function persistInlineAttachments(message: Message, filePath: string): Promise<void> {
  if (!message.attachments?.length) return
  const directory = sessionAssetDirectory(filePath)

  for (const attachment of message.attachments) {
    if (!attachment.dataURL) continue
    const parsed = parseImageDataURL(attachment.dataURL)
    const digest = createHash('sha256').update(parsed.bytes).digest('hex')
    const assetId = `${digest}.${imageExtension(parsed.mimeType)}`
    await mkdir(directory, { recursive: true })
    const assetPath = join(directory, assetId)
    if (!existsSync(assetPath)) await writeFile(assetPath, parsed.bytes, { flag: 'wx' }).catch(error => {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code !== 'EEXIST') throw error
    })
    attachment.assetId = assetId
    attachment.mimeType = parsed.mimeType
    attachment.byteLength = parsed.bytes.length
    attachment.dataURL = parsed.dataURL
  }
}

async function hydrateMessageAttachments(message: Message, filePath: string): Promise<void> {
  if (!message.attachments?.length) return
  await Promise.all(message.attachments.map(async attachment => {
    if (attachment.dataURL || !attachment.assetId || !isValidAssetId(attachment.assetId)) return
    try {
      const bytes = await readFile(join(sessionAssetDirectory(filePath), attachment.assetId))
      attachment.dataURL = `data:${attachment.mimeType};base64,${bytes.toString('base64')}`
      attachment.byteLength = attachment.byteLength ?? bytes.length
    } catch {
      // Keep the metadata so UIs can show a recoverable missing-asset state.
    }
  }))
}

function messageForTranscript(message: Message): Message {
  return {
    ...message,
    attachments: message.attachments?.map((attachment): MessageAttachment => persistedAttachment(attachment)),
  }
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
  let firstUserMessage: string | null = null
  let lastUserMessage: string | null = null
  let aiTitle: string | null = null
  let userTitle: string | null = null
  let compacted = false
  let updatedAt = fileInfo.mtime.toISOString()
  let activeWorktreePath: string | null = null
  let archived = false
  let metadata: SessionMetadata = {}
  let lastRun: SessionRunState | null = null

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue

    let record: SessionRecord
    try {
      record = JSON.parse(line) as SessionRecord
    } catch {
      continue
    }

    if (record.type !== 'session_title' && record.type !== 'session_resume') {
      updatedAt = record.timestamp || updatedAt
    }

    if (record.type === 'message_appended') {
      messageCount += 1
      if (record.message.role === 'user') {
        userMessageCount += 1
        const userMessage = displayUserMessage(record.message.content)
        firstUserMessage = firstUserMessage ?? userMessage
        lastUserMessage = userMessage ?? lastUserMessage
      }
    }

    if (record.type === 'session_metadata') {
      metadata = mergeSessionMetadata(metadata, record.metadata)
    }

    if (record.type === 'session_run_state') {
      lastRun = record.run
    }

    if (record.type === 'session_title') {
      if (record.source === 'user') userTitle = record.title
      else aiTitle = record.title
    }

    if (record.type === 'session_archive') {
      archived = record.archived
    }

    if (record.type === 'compact_boundary') {
      compacted = true
      messageCount = record.messages.length
      userMessageCount = record.messages.filter(message => message.role === 'user').length
      const lastUser = [...record.messages]
        .reverse()
        .find(message => message.role === 'user' && displayUserMessage(message.content))
      const firstUser = record.messages
        .find(message => message.role === 'user' && displayUserMessage(message.content))
      firstUserMessage = firstUserMessage ?? displayUserMessage(firstUser?.content)
      lastUserMessage = displayUserMessage(lastUser?.content) ?? lastUserMessage
    }

    if (record.type === 'worktree_event') {
      activeWorktreePath = record.action === 'entered' ? record.session?.worktreePath ?? null : null
    }
  }

  return {
    id: sessionIdFromPath(filePath),
    title: userTitle ?? aiTitle ?? titleFromUserMessage(firstUserMessage ?? lastUserMessage),
    filePath,
    updatedAt,
    messageCount,
    userMessageCount,
    firstUserMessage,
    lastUserMessage,
    hasPersistedTitle: Boolean(userTitle ?? aiTitle),
    compacted,
    activeWorktreePath,
    archived,
    metadata,
    lastRun,
  }
}

function mergeSessionMetadata(current: SessionMetadata, next: SessionMetadata): SessionMetadata {
  return {
    ...current,
    ...next,
    source: current.source || next.source
      ? { ...current.source, ...next.source }
      : undefined,
    workspace: current.workspace || next.workspace
      ? { ...current.workspace, ...next.workspace } as SessionWorkspaceMetadata
      : undefined,
  }
}

function isActiveRunStatus(status: SessionRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_approval'
}

function previewLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}...`
}

function displayUserMessage(content: string | null | undefined): string | null {
  if (!content?.trim()) return null
  if (content.startsWith('[Compacted conversation summary]')) return null

  const userRequest = '# User Request\n'
  if (content.startsWith(userRequest)) {
    const start = userRequest.length
    const boundaries = ['\n# Source Context', '\n# IDE Context']
      .map(marker => content.indexOf(marker, start))
      .filter(index => index !== -1)
    const contextStart = boundaries.length > 0 ? Math.min(...boundaries) : undefined
    return previewLine(content.slice(start, contextStart), 120)
  }

  return previewLine(content, 120)
}

function titleFromUserMessage(message: string | null): string {
  if (!message) return 'Untitled session'

  let title = message
    .replace(/^请|^帮我|^帮我一下|^你能不能|^可以帮我/g, '')
    .replace(/请必须.*$/g, '')
    .replace(/，?并解释.*$/g, '')
    .replace(/，?以及.*$/g, '')
    .replace(/，?然后.*$/g, '')
    .replace(/。.*$/g, '')
    .replace(/\?.*$/g, '')
    .replace(/？.*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!title) title = message.replace(/\s+/g, ' ').trim()
  return previewLine(title, 42)
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

function sessionDir(root = cwd()): string {
  return resolve(root, SESSION_DIR)
}

function resolveSessionPath(idOrPath: string, root = cwd()): string {
  if (idOrPath.includes('/') || idOrPath.endsWith('.jsonl')) return resolve(root, idOrPath)
  return resolve(join(sessionDir(root), `${idOrPath}.jsonl`))
}

async function latestSessionPath(): Promise<string | undefined> {
  const dir = sessionDir()
  if (!existsSync(dir)) return undefined
  const entries = await readdir(dir)
  const files = entries.filter(entry => entry.endsWith('.jsonl'))
  const withTime = await Promise.all(
    files.map(async file => {
      const filePath = join(dir, file)
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
