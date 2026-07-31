/**
 * agents.ts - simplified Claude Code-style AgentDefinition registry.
 *
 * Sub-agents are not a second architecture. They are named worker profiles that
 * run the same runAgent loop with isolated messages and a filtered tool pool.
 */

import type { Tool } from './types.js'

export const AGENT_TOOL_NAME = 'agent'

export interface AgentDefinition {
  agentType: string
  whenToUse: string
  tools?: string[]
  disallowedTools?: string[]
  maxTurns: number
  getSystemPrompt: () => string
}

export const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    agentType: 'explore',
    whenToUse:
      'Read-only codebase exploration. Use for broad search, finding files, tracing where behavior lives, or answering code-structure questions without editing.',
    tools: ['read_file', 'list_files', 'glob_files', 'grep_code'],
    maxTurns: 6,
    getSystemPrompt: () => `${baseAgentPrompt('explore')}

# Role
You are a read-only code exploration specialist.

# Rules
- Do not modify files or run shell commands.
- Use glob_files, grep_code, list_files, and read_file to inspect the repo.
- Return a concise report with concrete file paths and relevant findings.
- If the request is too broad, sample intelligently and say what you checked.`,
  },
  {
    agentType: 'review',
    whenToUse:
      'Independent code review. Use after reading a diff or changed files to find bugs, regressions, risky assumptions, and missing tests.',
    tools: ['read_file', 'list_files', 'glob_files', 'grep_code'],
    maxTurns: 6,
    getSystemPrompt: () => `${baseAgentPrompt('review')}

# Role
You are an independent code reviewer.

# Rules
- Do not modify files or run shell commands.
- Prioritize correctness bugs, behavioral regressions, security issues, and missing tests.
- Findings must include file paths and concrete reasoning.
- If no issues are found, say that clearly and mention residual risk or test gaps.`,
  },
  {
    agentType: 'verify',
    whenToUse:
      'Independent verification after implementation. Use to run checks, inspect outputs, and return PASS/FAIL/PARTIAL with evidence.',
    disallowedTools: ['agent', 'write_file', 'edit_file'],
    maxTurns: 8,
    getSystemPrompt: () => `${baseAgentPrompt('verify')}

# Role
You are a verification specialist. Your job is to test whether the implementation actually works.

# Rules
- Do not modify project files. Do not use write_file or edit_file.
- You may use read/search tools and run_command for builds, tests, linters, and read-only inspection.
- Run real commands when possible; reading code is not enough evidence.
- Report each check with: command run, output observed, result.
- End with exactly one final verdict line: VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL.`,
  },
  {
    agentType: 'general',
    whenToUse:
      'General focused sub-task. Use for bounded work that benefits from isolated context, while the main agent keeps the high-level thread.',
    disallowedTools: ['agent'],
    maxTurns: 8,
    getSystemPrompt: () => `${baseAgentPrompt('general')}

# Role
You are a focused worker agent.

# Rules
- Complete only the task in your prompt.
- Use tools as needed, but do not spawn another agent.
- Keep your final report concise and actionable.
- If you changed files or ran checks, state exactly what changed and what command output proved it.`,
  },
]

export function getAgentDefinition(agentType: string | undefined): AgentDefinition | undefined {
  const requested = (agentType || 'general').trim().toLowerCase()
  return BUILT_IN_AGENTS.find(agent => agent.agentType.toLowerCase() === requested)
}

export function formatAgentManifest(): string {
  return BUILT_IN_AGENTS
    .map(agent => `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${describeAgentTools(agent)})`)
    .join('\n')
}

export function resolveAgentTools(agent: AgentDefinition, allTools: Tool[]): Tool[] {
  const allowSet = agent.tools ? new Set(agent.tools) : null
  const denySet = new Set([AGENT_TOOL_NAME, ...(agent.disallowedTools ?? [])])

  return allTools.filter(tool => {
    if (allowSet && !allowSet.has(tool.name)) return false
    if (denySet.has(tool.name)) return false
    return true
  })
}

export function buildSubAgentSystemPrompt(agent: AgentDefinition, toolNames: string[]): string {
  return `${agent.getSystemPrompt()}

# Available Tools
${toolNames.map(name => `- ${name}`).join('\n') || '(none)'}

# Output
Return your final report directly. The parent agent will receive it as a tool result.`
}

function baseAgentPrompt(agentType: string): string {
  return `You are a Jesse-Agent sub-agent of type "${agentType}".
You run in an isolated conversation and report back to the parent agent.
Use the same language as the user's task unless the task asks otherwise.
Do not assume prior conversation context beyond what is included in your prompt.`
}

function describeAgentTools(agent: AgentDefinition): string {
  if (agent.tools && agent.tools.length > 0) return agent.tools.join(', ')
  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    return `all except ${agent.disallowedTools.join(', ')}`
  }
  return 'all tools'
}
