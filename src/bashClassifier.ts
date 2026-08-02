/**
 * bashClassifier.ts —— 保守 Bash 命令分类器
 *
 * 解决什么问题：
 *   run_command 是同一个工具，但 `git status` 和 `rm file` 风险完全不同。
 *   这里先做 Claude Code read-only validation 的极简版：只有能明确证明
 *   是只读的命令才自动放行；任何复杂语法、未知命令、可能写入的参数都继续 ask。
 *
 * 可扩展点：
 *   外部只调用 classifyBashCommand(command)。以后可以把本文件内部换成
 *   tree-sitter / AST / 更完整的安全规则，permissions.ts 不需要重写。
 */

export type BashCommandRisk = 'read_only' | 'needs_approval'

export interface BashCommandClassification {
  risk: BashCommandRisk
  reason: string
}

const COMPLEX_SHELL_SYNTAX = /[\n;&|<>`$(){}]/
const SENSITIVE_PATH = /^(?:~\/?|\$HOME\/?|\/|.*(?:^|\/)\.ssh(?:\/|$)|\/etc\/shadow$)/

export function classifyBashCommand(command: string): BashCommandClassification {
  const normalized = normalizeCommand(command)
  if (!normalized) {
    return needsApproval('空命令不自动放行。')
  }

  if (COMPLEX_SHELL_SYNTAX.test(normalized)) {
    return needsApproval('命令包含 shell 复合语法，保守起见需要确认。')
  }

  const tokens = tokenizeSimpleCommand(normalized)
  if (!tokens) {
    return needsApproval('命令参数无法安全解析，保守起见需要确认。')
  }

  const [program, ...args] = tokens
  if (!program) return needsApproval('空命令不自动放行。')

  if (hasSensitivePath(args)) {
    return needsApproval('命令访问系统或用户敏感路径，需要确认。')
  }

  if (isPwd(program, args)) return readOnly('pwd 只读取当前目录。')
  if (isEnvironmentProbe(program, args)) return readOnly(`${program} 是只读环境检查。`)
  if (isLs(program, args)) return readOnly('ls 只列出目录内容。')
  if (isFileRead(program, args)) return readOnly(`${program} 只读取项目内相对路径文件。`)
  if (isGitReadOnly(program, args)) return readOnly(`git ${args[0]} 被归类为只读 Git 查询。`)

  return needsApproval('不是保守白名单里的只读命令。')
}

function isPwd(program: string, args: string[]): boolean {
  return program === 'pwd' && args.every(arg => arg === '-L' || arg === '-P')
}

function isEnvironmentProbe(program: string, args: string[]): boolean {
  if (['date', 'whoami', 'uname'].includes(program)) return true
  if (program === 'which') return args.length > 0 && args.every(isPlainToken)
  if (program === 'command') return args[0] === '-v' && args.length === 2 && isPlainToken(args[1] ?? '')
  if (['node', 'npm', 'pnpm', 'yarn', 'python', 'python3'].includes(program)) {
    return args.length === 1 && ['-v', '--version', 'version'].includes(args[0] ?? '')
  }
  return false
}

function isLs(program: string, args: string[]): boolean {
  if (program !== 'ls') return false
  return args.every(arg => {
    if (arg.startsWith('-')) return /^-[A-Za-z1CFLRTabcdfghiklmnopqrstuvwx]+$/.test(arg)
    return isSafeRelativePath(arg)
  })
}

function isFileRead(program: string, args: string[]): boolean {
  switch (program) {
    case 'cat':
      return args.length > 0 && args.every(arg => {
        if (arg.startsWith('-')) return /^-[benstuvAET]+$/.test(arg)
        return isSafeRelativePath(arg)
      })
    case 'head':
    case 'tail':
      return args.length > 0 && allHeadTailArgsReadOnly(args)
    case 'wc':
      return args.length > 0 && args.every(arg => {
        if (arg.startsWith('-')) return /^-[clmwL]+$/.test(arg)
        return isSafeRelativePath(arg)
      })
    default:
      return false
  }
}

function allHeadTailArgsReadOnly(args: string[]): boolean {
  let sawPath = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) return false

    if (arg === '-n' || arg === '-c') {
      const value = args[index + 1]
      if (!value || !/^\d+$/.test(value)) return false
      index += 1
      continue
    }

    if (/^-[nc]\d+$/.test(arg)) continue
    if (arg.startsWith('-')) return false
    if (!isSafeRelativePath(arg)) return false
    sawPath = true
  }

  return sawPath
}

function isGitReadOnly(program: string, args: string[]): boolean {
  if (program !== 'git' || args.length === 0) return false

  const subcommand = args[0]
  const rest = args.slice(1)

  switch (subcommand) {
    case 'status':
      return allGitArgsReadOnly(rest, ['--short', '-s', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--branch', '-b', '--show-stash', '--ignored', '--untracked-files', '-u'])
    case 'diff':
      return allGitArgsReadOnly(rest, ['--cached', '--staged', '--stat', '--name-only', '--name-status', '--check', '--shortstat', '--summary', '--', '-U0', '-U1', '-U2', '-U3'])
    case 'log':
      return allGitArgsReadOnly(rest, ['--oneline', '--graph', '--decorate', '--stat', '--patch', '-p', '--name-only', '--name-status'])
    case 'show':
      return allGitArgsReadOnly(rest, ['--stat', '--name-only', '--name-status', '--pretty', '--format'])
    case 'rev-parse':
      return rest.length > 0 && rest.every(isGitReadOnlyValue)
    case 'ls-files':
    case 'grep':
      return rest.every(isGitReadOnlyValue)
    case 'branch':
      return rest.every(arg => ['--show-current', '--list', '-a', '-r', '-v', '-vv', '--all', '--remotes'].includes(arg) || isSafeRelativePath(arg))
    case 'remote':
      return rest[0] === '-v' || rest[0] === 'get-url'
    default:
      return false
  }
}

function allGitArgsReadOnly(args: string[], allowedFlags: string[]): boolean {
  return args.every(arg => {
    if (arg.startsWith('-')) return allowedFlags.includes(arg) || /^--max-count=\d+$/.test(arg) || /^-n\d+$/.test(arg)
    return isGitReadOnlyValue(arg)
  })
}

function isGitReadOnlyValue(value: string): boolean {
  if (value.includes('/') || value.includes('..')) return isSafeRelativePath(value)
  return isPlainToken(value)
}

function tokenizeSimpleCommand(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (char === undefined) continue

    if (quote === 'single') {
      if (char === "'") quote = null
      else current += char
      continue
    }

    if (quote === 'double') {
      if (char === '"') quote = null
      else current += char
      continue
    }

    if (char === "'") {
      quote = 'single'
      continue
    }

    if (char === '"') {
      quote = 'double'
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (quote) return null
  if (current) tokens.push(current)
  return tokens
}

function hasSensitivePath(args: string[]): boolean {
  return args.some(arg => SENSITIVE_PATH.test(arg))
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith('-')) return false
  if (value.startsWith('/') || value.startsWith('~') || value.includes('..')) return false
  if (value.includes('*')) return false
  return /^[A-Za-z0-9._/@:+,=-]+$/.test(value)
}

function isPlainToken(value: string): boolean {
  return /^[A-Za-z0-9._/@:+,=-]+$/.test(value)
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function readOnly(reason: string): BashCommandClassification {
  return { risk: 'read_only', reason }
}

function needsApproval(reason: string): BashCommandClassification {
  return { risk: 'needs_approval', reason }
}
