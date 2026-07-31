/**
 * agent.ts - focused sub-agent tool.
 *
 * This is the first useful slice of Claude Code's AgentTool: pick an agent
 * definition, filter its tools, run the same loop in an isolated message list,
 * and return the final report as a normal tool result. The thin async slice can
 * also register the same run as a background task.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LLMStreamer, Message } from '../llm.js'
import type { AgentEvent } from '../loop.js'
import type { Tool } from '../types.js'
import { createAgentRuntimeContext, type AgentRuntimeContext } from '../runtimeContext.js'
import { formatTaskDetails } from '../taskDisplay.js'
import { getTask, restoreAgentTask, startAgentTask, type AgentTaskContinuationContext, type TaskSnapshot } from '../tasks.js'
import {
  createAgentWorktree,
  finishAgentWorktree,
  type AgentWorktreeCleanupResult,
  type WorktreeSession,
} from '../worktrees.js'
import {
  buildSubAgentSystemPrompt,
  BUILT_IN_AGENTS,
  getAgentDefinition,
  resolveAgentTools,
} from '../agents.js'

const DEFAULT_AGENT_TYPE = 'general'
const TASK_OUTPUT_DIR = '.jesse/task-output'
const ISOLATED_WORKTREE_BLOCKED_TOOLS = new Set([
  'run_background_command',
  'task_list',
  'task_output',
  'task_stop',
  'enter_worktree',
  'exit_worktree',
])

type AgentIsolation = 'worktree'

export const agentTool: Tool = {
  name: 'agent',

  description:
    'Launch a focused sub-agent and return its final report. ' +
    'Use this for isolated exploration, review, verification, or bounded sub-tasks. ' +
    'Available subagent_type values: explore, review, verify, general. ' +
    'Each sub-agent has its own isolated context and restricted tool pool. ' +
    'Set run_in_background=true to return a task_id immediately. ' +
    'Set isolation="worktree" to run the sub-agent in an isolated git worktree.',

  parameters: {
    type: 'object',
    properties: {
      subagent_type: {
        type: 'string',
        description: 'Agent type to run: explore, review, verify, or general. Defaults to general.',
      },
      description: {
        type: 'string',
        description: 'Short 3-5 word description of what the sub-agent will do.',
      },
      prompt: {
        type: 'string',
        description: 'Complete task brief for the sub-agent. Include all context it needs.',
      },
      max_turns: {
        type: 'number',
        description: 'Optional maximum agentic turns. Defaults to the selected agent type limit.',
      },
      isolation: {
        type: 'string',
        description: 'Optional isolation mode. Use "worktree" to run this sub-agent in an isolated git worktree.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Optional. If true, start the sub-agent as a background task and return task_id immediately.',
      },
    },
    required: ['prompt'],
  },

  isReadOnly: false,

  async execute(args, context?: AgentRuntimeContext) {
    const isolation = parseIsolation(args.isolation)
    if (isolation instanceof Error) return `错误：${isolation.message}`
    const runInBackground = args.run_in_background === true

    const prepared = await prepareAgentRun(args, isolation, context)
    if (typeof prepared === 'string') return prepared

    if (runInBackground) {
      const task = await startBackgroundAgentTask(prepared)
      return formatStartedAgentTask(task)
    }

    const result = await runPreparedAgent(prepared)
    return formatAgentResult(result)
  },
}

interface PreparedAgentRun {
  agentType: string
  description: string
  maxTurns: number
  subAgentTools: Tool[]
  messages: Message[]
  runtimeContext: AgentRuntimeContext
  isolation: AgentIsolation | undefined
  worktreeSession: WorktreeSession | null
}

interface AgentRunResult {
  agentType: string
  status: 'completed' | 'max_turns' | 'error'
  maxTurns: number
  toolCalls: string[]
  errors: string[]
  finalText: string
  isolation: AgentIsolation | undefined
  worktreeSession: WorktreeSession | null
  worktreeResult: AgentWorktreeCleanupResult | null
  worktreeCleanupError: string | null
}

interface BackgroundAgentMetadata {
  version: 1
  taskId: string
  agentType: string
  description: string
  maxTurns: number
  isolation: AgentIsolation | null
  runtimeContext: AgentRuntimeContext
  worktreeSession: WorktreeSession | null
  worktreeResult: AgentWorktreeCleanupResult | null
  worktreeCleanupError: string | null
  subAgentToolNames: string[]
  updatedAt: string
}

interface RestoreBackgroundAgentOptions {
  llmStream?: LLMStreamer
}

async function prepareAgentRun(
  args: Record<string, unknown>,
  isolation: AgentIsolation | undefined,
  parentContext?: AgentRuntimeContext,
): Promise<PreparedAgentRun | string> {
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) return '错误：未提供 prompt 参数。'

  const requestedType = typeof args.subagent_type === 'string'
    ? args.subagent_type.trim()
    : DEFAULT_AGENT_TYPE
  const agent = getAgentDefinition(requestedType)
  if (!agent) {
    return [
      `错误：未知 subagent_type "${requestedType}"。`,
      `可用类型：${BUILT_IN_AGENTS.map(def => def.agentType).join(', ')}`,
    ].join('\n')
  }

  const { getAllTools } = await import('./index.js')
  const subAgentTools = filterToolsForIsolation(resolveAgentTools(agent, getAllTools()), isolation)
  const maxTurns = parseMaxTurns(args.max_turns, agent.maxTurns)
  const resolvedParentContext = parentContext ?? createAgentRuntimeContext()
  const parentProjectRoot = resolvedParentContext.projectRoot
  const agentId = createAgentId(agent.agentType)
  let worktreeSession: WorktreeSession | null = null

  if (isolation === 'worktree') {
    worktreeSession = await createAgentWorktree({
      agentId,
      baseProjectRoot: resolvedParentContext.projectRoot,
    })
  }

  const runtimeContext = createAgentRuntimeContext({
    agentId,
    projectRoot: worktreeSession?.worktreePath ?? resolvedParentContext.projectRoot,
    cwd: worktreeSession?.worktreePath ?? resolvedParentContext.cwd,
    originalProjectRoot: resolvedParentContext.originalProjectRoot,
    worktreeSession,
  })

  const messages: Message[] = [
    {
      role: 'system',
      content: buildSubAgentSystemPrompt(agent, subAgentTools.map(tool => tool.name)),
    },
    {
      role: 'user',
      content: buildTaskPrompt(args.description, prompt, worktreeSession, parentProjectRoot),
    },
  ]

  return {
    agentType: agent.agentType,
    description: normalizeAgentDescription(args.description, agent.agentType),
    maxTurns,
    subAgentTools,
    messages,
    runtimeContext,
    isolation,
    worktreeSession,
  }
}

async function startBackgroundAgentTask(prepared: PreparedAgentRun): Promise<TaskSnapshot> {
  const handlers = createBackgroundAgentTaskHandlers(prepared)
  return await startAgentTask({
    description: prepared.description,
    run: handlers.run,
    continueRun: handlers.continueRun,
  })
}

export async function restoreBackgroundAgentTask(
  taskId: string,
  options: RestoreBackgroundAgentOptions = {},
): Promise<TaskSnapshot> {
  const existing = getTask(taskId)
  if (existing) return existing

  const prepared = await loadPreparedAgentRun(taskId)
  return await restoreAgentTask({
    id: taskId,
    description: prepared.description,
    outputPath: agentOutputPath(taskId),
    transcriptPath: agentTranscriptPath(taskId),
    continueRun: createBackgroundAgentTaskHandlers(prepared, options).continueRun,
  })
}

function createBackgroundAgentTaskHandlers(
  prepared: PreparedAgentRun,
  options: RestoreBackgroundAgentOptions = {},
): {
  run: (context: { taskId: string; signal: AbortSignal; write(chunk: string | Buffer): void }) => Promise<void>
  continueRun: (context: AgentTaskContinuationContext) => Promise<void>
} {
  return {
    run: async context => {
      context.write(formatBackgroundAgentHeader(prepared, context.taskId))
      const result = await runPreparedAgent(prepared, {
        signal: context.signal,
        llmStream: options.llmStream,
        onEvent: event => writeBackgroundAgentEvent(context.write, event),
      })
      await writeAgentState(context.taskId, prepared, result)
      context.write('\n--- final report ---\n')
      context.write(formatAgentResult(result))
      context.write('\n')
    },
    continueRun: async context => {
      prepared.messages.push({ role: 'user', content: context.prompt })
      context.write(formatBackgroundAgentContinuationHeader(prepared, context.taskId, context.prompt))
      const result = await runPreparedAgent(prepared, {
        signal: context.signal,
        llmStream: options.llmStream,
        onEvent: event => writeBackgroundAgentEvent(context.write, event),
      })
      await writeAgentState(context.taskId, prepared, result)
      context.write('\n--- continued final report ---\n')
      context.write(formatAgentResult(result))
      context.write('\n')
    },
  }
}

async function loadPreparedAgentRun(taskId: string): Promise<PreparedAgentRun> {
  const messages = await readAgentTranscript(agentTranscriptPath(taskId))
  const metadata = await readAgentMetadata(taskId)
  const agentType = metadata?.agentType ?? inferAgentType(messages)
  const agent = getAgentDefinition(agentType)
  if (!agent) throw new Error(`无法恢复后台 agent：未知 agent type ${agentType}`)

  if (metadata?.worktreeResult?.status === 'removed') {
    throw new Error(`无法恢复后台 agent ${taskId}：它的 worktree 已在上次运行结束时自动清理。`)
  }

  const isolation = metadata?.isolation ?? undefined
  const { getAllTools } = await import('./index.js')
  const subAgentTools = filterToolsForIsolation(resolveAgentTools(agent, getAllTools()), isolation)
  const runtimeContext = metadata?.runtimeContext
    ? createAgentRuntimeContext(metadata.runtimeContext)
    : createAgentRuntimeContext()
  const worktreeSession = metadata?.worktreeSession ?? runtimeContext.worktreeSession ?? null

  if (worktreeSession && !(await isDirectory(worktreeSession.worktreePath))) {
    throw new Error(`无法恢复后台 agent ${taskId}：worktree 不存在或不可读：${worktreeSession.worktreePath}`)
  }

  return {
    agentType: agent.agentType,
    description: metadata?.description ?? inferAgentDescription(messages, agent.agentType),
    maxTurns: metadata?.maxTurns ?? agent.maxTurns,
    subAgentTools,
    messages,
    runtimeContext,
    isolation,
    worktreeSession,
  }
}

async function writeAgentState(
  taskId: string,
  prepared: PreparedAgentRun,
  result: AgentRunResult,
): Promise<void> {
  await Promise.all([
    writeAgentTranscript(taskId, prepared.messages),
    writeAgentMetadata(taskId, prepared, result),
  ])
}

async function writeAgentMetadata(
  taskId: string,
  prepared: PreparedAgentRun,
  result: AgentRunResult,
): Promise<void> {
  const path = agentMetadataPath(taskId)
  await mkdir(dirname(path), { recursive: true })
  const metadata: BackgroundAgentMetadata = {
    version: 1,
    taskId,
    agentType: prepared.agentType,
    description: prepared.description,
    maxTurns: prepared.maxTurns,
    isolation: prepared.isolation ?? null,
    runtimeContext: prepared.runtimeContext,
    worktreeSession: prepared.worktreeSession,
    worktreeResult: result.worktreeResult,
    worktreeCleanupError: result.worktreeCleanupError,
    subAgentToolNames: prepared.subAgentTools.map(tool => tool.name),
    updatedAt: new Date().toISOString(),
  }
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
}

async function readAgentMetadata(taskId: string): Promise<BackgroundAgentMetadata | null> {
  try {
    const raw = await readFile(agentMetadataPath(taskId), 'utf8')
    const parsed = JSON.parse(raw) as Partial<BackgroundAgentMetadata>
    if (parsed.version !== 1 || parsed.taskId !== taskId || !parsed.agentType) {
      throw new Error(`metadata 格式无效：${agentMetadataPath(taskId)}`)
    }
    return parsed as BackgroundAgentMetadata
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function readAgentTranscript(path: string): Promise<Message[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`无法恢复后台 agent：找不到 transcript ${path}`)
    }
    throw err
  }

  const messages = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => parseTranscriptMessage(line, path, index + 1))
  if (messages.length === 0) throw new Error(`无法恢复后台 agent：transcript 为空 ${path}`)
  return messages
}

function parseTranscriptMessage(line: string, path: string, lineNumber: number): Message {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`无法解析 agent transcript ${path}:${lineNumber}: ${reason}`)
  }

  if (!isMessage(value)) {
    throw new Error(`agent transcript ${path}:${lineNumber} 不是有效 message`)
  }
  return value
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Message>
  return (
    candidate.role === 'system' ||
    candidate.role === 'user' ||
    candidate.role === 'assistant' ||
    candidate.role === 'tool'
  ) && (typeof candidate.content === 'string' || candidate.content === null)
}

function inferAgentType(messages: Message[]): string {
  const system = messages.find(message => message.role === 'system')?.content ?? ''
  const match = /sub-agent of type "([^"]+)"/.exec(system)
  return match?.[1] ?? DEFAULT_AGENT_TYPE
}

function inferAgentDescription(messages: Message[], agentType: string): string {
  const firstUser = messages.find(message => message.role === 'user')?.content ?? ''
  const match = /^Task description:\s*(.+)$/m.exec(firstUser)
  return match?.[1]?.trim() || `${agentType} restored sub-agent`
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function runPreparedAgent(
  prepared: PreparedAgentRun,
  options: {
    signal?: AbortSignal
    llmStream?: LLMStreamer
    onEvent?: (event: AgentEvent) => void
  } = {},
): Promise<AgentRunResult> {
  const { runAgent } = await import('../loop.js')
  let worktreeResult: AgentWorktreeCleanupResult | null = null
  let worktreeCleanupError: string | null = null
  let finalText = ''
  let terminalStatus: 'completed' | 'max_turns' | 'error' = 'completed'
  const toolCalls: string[] = []
  const errors: string[] = []

  try {
    for await (const event of runAgent(prepared.messages, {
      tools: prepared.subAgentTools,
      maxTurns: prepared.maxTurns,
      llmStream: options.llmStream,
      signal: options.signal,
      context: prepared.runtimeContext,
    })) {
      options.onEvent?.(event)
      if (event.type === 'tool_start') {
        toolCalls.push(event.name)
      } else if (event.type === 'assistant_text') {
        finalText = event.text
      } else if (event.type === 'error') {
        terminalStatus = 'error'
        errors.push(event.reason)
      } else if (event.type === 'max_turns') {
        terminalStatus = 'max_turns'
      }
    }
  } finally {
    if (prepared.worktreeSession) {
      try {
        worktreeResult = await finishAgentWorktree(prepared.worktreeSession)
      } catch (err) {
        worktreeCleanupError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  return {
    agentType: prepared.agentType,
    status: terminalStatus,
    maxTurns: prepared.maxTurns,
    toolCalls,
    errors,
    finalText,
    isolation: prepared.isolation,
    worktreeSession: prepared.worktreeSession,
    worktreeResult,
    worktreeCleanupError,
  }
}

function parseIsolation(value: unknown): AgentIsolation | undefined | Error {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'worktree') return 'worktree'
  return new Error('isolation 目前只支持 "worktree"')
}

function filterToolsForIsolation(tools: Tool[], isolation: AgentIsolation | undefined): Tool[] {
  if (isolation !== 'worktree') return tools
  return tools.filter(tool => !ISOLATED_WORKTREE_BLOCKED_TOOLS.has(tool.name))
}

function parseMaxTurns(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(20, Math.floor(value)))
}

function buildTaskPrompt(
  description: unknown,
  prompt: string,
  worktreeSession: WorktreeSession | null,
  parentProjectRoot: string,
): string {
  const shortDescription = typeof description === 'string' && description.trim()
    ? description.trim()
    : 'Focused sub-agent task'

  const sections = [`Task description: ${shortDescription}`]
  if (worktreeSession) sections.push('', buildWorktreeNotice(parentProjectRoot, worktreeSession))
  sections.push('', prompt)
  return sections.join('\n')
}

function buildWorktreeNotice(parentProjectRoot: string, session: WorktreeSession): string {
  return [
    '# Worktree Isolation',
    `Parent project root: ${parentProjectRoot}`,
    `Your project root: ${session.worktreePath}`,
    `Your git branch: ${session.worktreeBranch}`,
    '',
    'You are operating in an isolated git worktree with the same repository structure but a separate working copy.',
    'Paths from the parent context may refer to the parent project root; translate them to your worktree root before reading or editing.',
    'Re-read files before editing. Your changes stay in this worktree and will not affect the parent project directly.',
  ].join('\n')
}

function formatAgentResult({
  agentType,
  status,
  maxTurns,
  toolCalls,
  errors,
  finalText,
  isolation,
  worktreeSession,
  worktreeResult,
  worktreeCleanupError,
}: {
  agentType: string
  status: 'completed' | 'max_turns' | 'error'
  maxTurns: number
  toolCalls: string[]
  errors: string[]
  finalText: string
  isolation: AgentIsolation | undefined
  worktreeSession: WorktreeSession | null
  worktreeResult: AgentWorktreeCleanupResult | null
  worktreeCleanupError: string | null
}): string {
  const lines = [
    `Sub-agent: ${agentType}`,
    `Status: ${status}`,
    `Max turns: ${maxTurns}`,
    `Tool calls: ${summarizeToolCalls(toolCalls)}`,
  ]

  if (isolation) {
    lines.push(`Isolation: ${isolation}`)
  }

  if (worktreeSession) {
    lines.push(`Worktree path: ${worktreeSession.worktreePath}`)
    lines.push(`Worktree branch: ${worktreeSession.worktreeBranch}`)
  }

  if (worktreeResult) {
    lines.push(`Worktree status: ${worktreeResult.status}`)
    lines.push(`Worktree changes: ${worktreeResult.changedFiles} file(s), ${worktreeResult.commits} commit(s)`)
    lines.push(`Worktree message: ${worktreeResult.message}`)
  } else if (worktreeCleanupError) {
    lines.push('Worktree status: kept')
    lines.push(`Worktree cleanup error: ${worktreeCleanupError}`)
  }

  if (errors.length > 0) {
    lines.push('', 'Errors:', ...errors.map(error => `- ${error}`))
  }

  lines.push('', 'Final report:', finalText.trim() || '(sub-agent did not produce a final text report)')
  return lines.join('\n')
}

function createAgentId(agentType: string): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z')
  const suffix = Math.random().toString(36).slice(2, 8)
  return `agent-${agentType}-${stamp}-${suffix}`
}

function normalizeAgentDescription(description: unknown, agentType: string): string {
  if (typeof description === 'string' && description.trim()) return description.trim()
  return `${agentType} sub-agent`
}

function formatStartedAgentTask(task: TaskSnapshot): string {
  return [
    'Background sub-agent started.',
    formatTaskDetails(task),
    '',
    'Use task_output with this task_id to read progress and the final report later. Use task_stop to cancel it if needed.',
  ].join('\n')
}

function formatBackgroundAgentHeader(prepared: PreparedAgentRun, taskId: string): string {
  return [
    `task_id: ${taskId}`,
    `transcript_path: ${agentTranscriptPath(taskId)}`,
    `sub_agent: ${prepared.agentType}`,
    `description: ${prepared.description}`,
    `max_turns: ${prepared.maxTurns}`,
    `tools: ${prepared.subAgentTools.map(tool => tool.name).join(', ')}`,
    '',
    '--- progress ---',
  ].join('\n') + '\n'
}

function formatBackgroundAgentContinuationHeader(
  prepared: PreparedAgentRun,
  taskId: string,
  prompt: string,
): string {
  return [
    '',
    '--- continuation ---',
    `task_id: ${taskId}`,
    `transcript_path: ${agentTranscriptPath(taskId)}`,
    `sub_agent: ${prepared.agentType}`,
    `prompt: ${previewText(prompt, 1_000)}`,
    '',
    '--- progress ---',
  ].join('\n') + '\n'
}

function writeBackgroundAgentEvent(write: (chunk: string | Buffer) => void, event: AgentEvent): void {
  if (event.type === 'turn_start') {
    write(`[turn ${event.turn}]\n`)
  } else if (event.type === 'tool_start') {
    write(`[tool_start] ${event.name}: ${previewJson(event.args, 700)}\n`)
  } else if (event.type === 'tool_result') {
    write(`[tool_result] ${event.name}: ${event.ok ? 'ok' : 'error'} (${event.content.length} chars)\n`)
    const preview = previewText(event.content, 1_200)
    if (preview) write(`${preview}\n`)
  } else if (event.type === 'assistant_text') {
    write(`[assistant_text] ${event.text.length} chars\n`)
  } else if (event.type === 'error') {
    write(`[error] ${event.reason}\n`)
  } else if (event.type === 'max_turns') {
    write('[max_turns]\n')
  }
}

function previewJson(value: unknown, maxChars: number): string {
  try {
    return previewText(JSON.stringify(value), maxChars)
  } catch {
    return previewText(String(value), maxChars)
  }
}

function previewText(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}...`
}

async function writeAgentTranscript(taskId: string, messages: Message[]): Promise<void> {
  const path = agentTranscriptPath(taskId)
  await mkdir(dirname(path), { recursive: true })
  const jsonl = messages.map(message => JSON.stringify(message)).join('\n')
  await writeFile(path, `${jsonl}\n`, 'utf8')
}

function agentTranscriptPath(taskId: string): string {
  return join(TASK_OUTPUT_DIR, `${taskId}.messages.jsonl`)
}

function agentMetadataPath(taskId: string): string {
  return join(TASK_OUTPUT_DIR, `${taskId}.agent.json`)
}

function agentOutputPath(taskId: string): string {
  return join(TASK_OUTPUT_DIR, `${taskId}.log`)
}

function summarizeToolCalls(toolCalls: string[]): string {
  if (toolCalls.length === 0) return 'none'

  const counts = new Map<string, number>()
  for (const name of toolCalls) counts.set(name, (counts.get(name) ?? 0) + 1)
  return Array.from(counts.entries())
    .map(([name, count]) => (count === 1 ? name : `${name} x${count}`))
    .join(', ')
}
