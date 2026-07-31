/**
 * agent.ts - synchronous sub-agent tool.
 *
 * This is the first useful slice of Claude Code's AgentTool: pick an agent
 * definition, filter its tools, run the same loop in an isolated message list,
 * and return the final report as a normal tool result.
 */

import type { Message } from '../llm.js'
import type { Tool } from '../types.js'
import { getProjectRoot, setProjectRoot } from '../workingDirectory.js'
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
    'Launch a synchronous focused sub-agent and return its final report. ' +
    'Use this for isolated exploration, review, verification, or bounded sub-tasks. ' +
    'Available subagent_type values: explore, review, verify, general. ' +
    'Each sub-agent has its own isolated context and restricted tool pool. ' +
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
        description: 'Optional isolation mode. Use "worktree" to run this synchronous sub-agent in an isolated git worktree.',
      },
    },
    required: ['prompt'],
  },

  isReadOnly: false,

  async execute(args) {
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) return '错误：未提供 prompt 参数。'

    const isolation = parseIsolation(args.isolation)
    if (isolation instanceof Error) return `错误：${isolation.message}`

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
    const { runAgent } = await import('../loop.js')
    const subAgentTools = filterToolsForIsolation(resolveAgentTools(agent, getAllTools()), isolation)
    const maxTurns = parseMaxTurns(args.max_turns, agent.maxTurns)
    const parentProjectRoot = getProjectRoot()
    const agentId = createAgentId(agent.agentType)
    let worktreeSession: WorktreeSession | null = null
    let worktreeResult: AgentWorktreeCleanupResult | null = null
    let worktreeCleanupError: string | null = null

    if (isolation === 'worktree') {
      worktreeSession = await createAgentWorktree({ agentId })
    }

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

    let finalText = ''
    let terminalStatus: 'completed' | 'max_turns' | 'error' = 'completed'
    const toolCalls: string[] = []
    const errors: string[] = []

    try {
      await withProjectRoot(worktreeSession?.worktreePath ?? null, async () => {
        for await (const event of runAgent(messages, { tools: subAgentTools, maxTurns })) {
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
      })
    } finally {
      if (worktreeSession) {
        try {
          worktreeResult = await finishAgentWorktree(worktreeSession)
        } catch (err) {
          worktreeCleanupError = err instanceof Error ? err.message : String(err)
        }
      }
    }

    return formatAgentResult({
      agentType: agent.agentType,
      status: terminalStatus,
      maxTurns,
      toolCalls,
      errors,
      finalText,
      isolation,
      worktreeSession,
      worktreeResult,
      worktreeCleanupError,
    })
  },
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

async function withProjectRoot<T>(projectRoot: string | null, fn: () => Promise<T>): Promise<T> {
  if (!projectRoot) return await fn()

  const previousProjectRoot = getProjectRoot()
  const previousCwd = process.cwd()
  process.chdir(projectRoot)
  await setProjectRoot(projectRoot)
  try {
    return await fn()
  } finally {
    process.chdir(previousCwd)
    await setProjectRoot(previousProjectRoot)
  }
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

function summarizeToolCalls(toolCalls: string[]): string {
  if (toolCalls.length === 0) return 'none'

  const counts = new Map<string, number>()
  for (const name of toolCalls) counts.set(name, (counts.get(name) ?? 0) + 1)
  return Array.from(counts.entries())
    .map(([name, count]) => (count === 1 ? name : `${name} x${count}`))
    .join(', ')
}
