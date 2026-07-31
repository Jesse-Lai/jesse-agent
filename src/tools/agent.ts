/**
 * agent.ts - synchronous sub-agent tool.
 *
 * This is the first useful slice of Claude Code's AgentTool: pick an agent
 * definition, filter its tools, run the same loop in an isolated message list,
 * and return the final report as a normal tool result.
 */

import type { Message } from '../llm.js'
import type { Tool } from '../types.js'
import {
  buildSubAgentSystemPrompt,
  BUILT_IN_AGENTS,
  getAgentDefinition,
  resolveAgentTools,
} from '../agents.js'

const DEFAULT_AGENT_TYPE = 'general'

export const agentTool: Tool = {
  name: 'agent',

  description:
    'Launch a synchronous focused sub-agent and return its final report. ' +
    'Use this for isolated exploration, review, verification, or bounded sub-tasks. ' +
    'Available subagent_type values: explore, review, verify, general. ' +
    'Each sub-agent has its own isolated context and restricted tool pool.',

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
    },
    required: ['prompt'],
  },

  isReadOnly: false,

  async execute(args) {
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
    const { runAgent } = await import('../loop.js')
    const subAgentTools = resolveAgentTools(agent, getAllTools())
    const maxTurns = parseMaxTurns(args.max_turns, agent.maxTurns)

    const messages: Message[] = [
      {
        role: 'system',
        content: buildSubAgentSystemPrompt(agent, subAgentTools.map(tool => tool.name)),
      },
      {
        role: 'user',
        content: buildTaskPrompt(args.description, prompt),
      },
    ]

    let finalText = ''
    let terminalStatus: 'completed' | 'max_turns' | 'error' = 'completed'
    const toolCalls: string[] = []
    const errors: string[] = []

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

    return formatAgentResult({
      agentType: agent.agentType,
      status: terminalStatus,
      maxTurns,
      toolCalls,
      errors,
      finalText,
    })
  },
}

function parseMaxTurns(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(20, Math.floor(value)))
}

function buildTaskPrompt(description: unknown, prompt: string): string {
  const shortDescription = typeof description === 'string' && description.trim()
    ? description.trim()
    : 'Focused sub-agent task'

  return [`Task description: ${shortDescription}`, '', prompt].join('\n')
}

function formatAgentResult({
  agentType,
  status,
  maxTurns,
  toolCalls,
  errors,
  finalText,
}: {
  agentType: string
  status: 'completed' | 'max_turns' | 'error'
  maxTurns: number
  toolCalls: string[]
  errors: string[]
  finalText: string
}): string {
  const lines = [
    `Sub-agent: ${agentType}`,
    `Status: ${status}`,
    `Max turns: ${maxTurns}`,
    `Tool calls: ${summarizeToolCalls(toolCalls)}`,
  ]

  if (errors.length > 0) {
    lines.push('', 'Errors:', ...errors.map(error => `- ${error}`))
  }

  lines.push('', 'Final report:', finalText.trim() || '(sub-agent did not produce a final text report)')
  return lines.join('\n')
}

function summarizeToolCalls(toolCalls: string[]): string {
  if (toolCalls.length === 0) return 'none'

  const counts = new Map<string, number>()
  for (const name of toolCalls) counts.set(name, (counts.get(name) ?? 0) + 1)
  return Array.from(counts.entries())
    .map(([name, count]) => (count === 1 ? name : `${name} x${count}`))
    .join(', ')
}
