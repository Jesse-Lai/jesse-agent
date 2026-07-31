/**
 * permissions.ts —— 小型权限规则系统
 *
 * 解决什么问题：
 *   简单 y/N 每次都会打断用户。Claude Code 的 Bash 权限弹窗支持
 *   "Yes, and don't ask again for ..."，本文件先做这个骨架：
 *   - ask：没有规则时询问用户
 *   - allow：用户选择本次会话记住后，后续匹配的操作直接放行
 *   - deny：先用于硬拦截明显危险命令；普通弹窗暂不提供"永久拒绝"
 *
 * 对应 Claude Code：
 *   src/utils/permissions/PermissionRule.ts 与 BashTool/bashPermissions.ts。
 *   Claude Code 底层支持 allow/deny/ask，但 Bash 弹窗常见选项是
 *   Yes / Yes, and don't ask again for ... / No。
 */
import { classifyBashCommand } from './bashClassifier.js'

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

type RuleMatchKind = 'exact' | 'prefix'

export interface PermissionRule {
  toolName: string
  behavior: PermissionBehavior
  match: {
    kind: RuleMatchKind
    value: string
  }
  description: string
}

export interface PermissionDecision {
  behavior: PermissionBehavior
  rule?: PermissionRule
  reason?: string
}

const sessionRules: PermissionRule[] = []

/** 先查硬拦截，再查本次会话规则；能证明只读则放行；否则 ask。 */
export function checkPermission(toolName: string, args: Record<string, unknown>): PermissionDecision {
  const hardDenyReason = getHardDenyReason(toolName, args)
  if (hardDenyReason) {
    return { behavior: 'deny', reason: hardDenyReason }
  }

  const rule = sessionRules.find(candidate => matchesRule(candidate, toolName, args))
  if (rule) {
    return { behavior: rule.behavior, rule, reason: `命中本次会话权限规则：${rule.description}` }
  }

  const readOnlyReason = getReadOnlyReason(toolName, args)
  if (readOnlyReason) {
    return { behavior: 'allow', reason: readOnlyReason }
  }

  return { behavior: 'ask' }
}

/** 用户选择“本次会话记住”后，把建议规则加入内存。 */
export function rememberSessionAllowRule(toolName: string, args: Record<string, unknown>): PermissionRule {
  const rule = createSuggestedAllowRule(toolName, args)

  const existing = sessionRules.find(candidate => sameRule(candidate, rule))
  if (existing) return existing

  sessionRules.push(rule)
  return rule
}

export function describeRule(rule: PermissionRule): string {
  return rule.description
}

function createSuggestedAllowRule(toolName: string, args: Record<string, unknown>): PermissionRule {
  if (isShellCommandTool(toolName) && typeof args.command === 'string') {
    const command = normalizeCommand(args.command)
    const prefix = getCommandPrefix(command)

    if (prefix) {
      return {
        toolName,
        behavior: 'allow',
        match: { kind: 'prefix', value: prefix },
        description: `允许 ${toolName} 前缀：${prefix}*`,
      }
    }

    return {
      toolName,
      behavior: 'allow',
      match: { kind: 'exact', value: command },
      description: `允许 ${toolName} 命令：${command}`,
    }
  }

  const action = stableActionKey(toolName, args)
  return {
    toolName,
    behavior: 'allow',
    match: { kind: 'exact', value: action },
    description: `允许 ${toolName} 操作：${action}`,
  }
}

function matchesRule(rule: PermissionRule, toolName: string, args: Record<string, unknown>): boolean {
  if (rule.toolName !== toolName) return false

  const value = isShellCommandTool(toolName) && typeof args.command === 'string'
    ? normalizeCommand(args.command)
    : stableActionKey(toolName, args)

  if (rule.match.kind === 'exact') return value === rule.match.value
  return value === rule.match.value || value.startsWith(`${rule.match.value} `)
}

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return (
    a.toolName === b.toolName &&
    a.behavior === b.behavior &&
    a.match.kind === b.match.kind &&
    a.match.value === b.match.value
  )
}

function getHardDenyReason(toolName: string, args: Record<string, unknown>): string | null {
  if (!isShellCommandTool(toolName) || typeof args.command !== 'string') return null

  const command = normalizeCommand(args.command)
  const lower = command.toLowerCase()

  if (lower.includes(':(){') || lower.includes(': () {')) {
    return '命令看起来像 fork bomb，已被硬拦截。'
  }

  const rootOrHomeTarget = String.raw`["']?(?:\/|\/\*|~\/?|\$HOME\/?)['"]?(?:\s|$)`
  if (new RegExp(String.raw`\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]*\s+${rootOrHomeTarget}`, 'i').test(command)) {
    return '命令会递归强制删除根目录或用户主目录，已被硬拦截。'
  }

  if (/\bmkfs(?:\.|\s)/i.test(command)) {
    return '命令可能格式化磁盘，已被硬拦截。'
  }

  if (/\bdd\s+.*\bof=\/dev\//i.test(command) || /\bdd\s+.*\bif=\/dev\//i.test(command)) {
    return '命令直接读写设备文件，已被硬拦截。'
  }

  if (new RegExp(String.raw`\bchmod\s+-R\s+777\s+${rootOrHomeTarget}`, 'i').test(command)) {
    return '命令会递归放开系统或主目录权限，已被硬拦截。'
  }

  if (new RegExp(String.raw`\bchown\s+-R\s+\S+\s+${rootOrHomeTarget}`, 'i').test(command)) {
    return '命令会递归修改系统或主目录所有者，已被硬拦截。'
  }

  if (/(?:^|\s)(?:cat|less|more|tail|head|cp|mv|rm|open)\s+.*(?:~\/\.ssh|\$HOME\/\.ssh|\/\.ssh\/|\/etc\/shadow)/i.test(command)) {
    return '命令触碰 SSH 密钥或系统敏感文件，已被硬拦截。'
  }

  return null
}

function getReadOnlyReason(toolName: string, args: Record<string, unknown>): string | null {
  if (!isShellCommandTool(toolName) || typeof args.command !== 'string') return null

  const classification = classifyBashCommand(args.command)
  if (classification.risk !== 'read_only') return null

  return `只读 Bash 命令自动放行：${classification.reason}`
}

function isShellCommandTool(toolName: string): boolean {
  return toolName === 'run_command' || toolName === 'run_background_command'
}

function getCommandPrefix(command: string): string | null {
  const words = command.split(' ').filter(Boolean)
  if (words.length === 0) return null

  const strippedWords = stripLeadingEnvironmentAssignments(words)
  const first = strippedWords[0]
  if (!first || !isSimpleExecutable(first)) return null

  const second = strippedWords[1]

  if (first === 'npm' && second === 'run') return 'npm run'
  if (first === 'pnpm' && second) return `pnpm ${second}`
  if (first === 'yarn' && second) return `yarn ${second}`
  if (first === 'git' && second) return `git ${second}`

  return first
}

function stripLeadingEnvironmentAssignments(words: string[]): string[] {
  let index = 0
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) {
    index += 1
  }
  return words.slice(index)
}

function isSimpleExecutable(word: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(word) && !word.startsWith('-')
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function stableActionKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(sortObject(args))}`
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortObject(nested)]),
  )
}
