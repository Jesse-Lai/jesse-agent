import { stdout } from 'node:process'
import type { AgentEvent } from './loop.js'
import { formatSimpleDiff } from './diff.js'

export interface CliRendererOptions {
  verbose: boolean
}

export interface StartupInfo {
  sessionId: string
  modeTitle: string
  mcpToolCount: number
  mcpServerCount: number
  mcpErrors: string[]
  worktreePath?: string
  resumedMessageCount?: number
}

export class CliRenderer {
  private readonly verbose: boolean
  private streaming = false
  private thinkingTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: CliRendererOptions) {
    this.verbose = options.verbose
  }

  renderStartup(info: StartupInfo): void {
    console.log('Jesse-Agent')
    console.log('  输入你的问题开始聊天；/plan 计划；/mode 权限；/compact 压缩；/diff 改动；/sessions 历史；exit 退出。')
    console.log(`  Session: ${info.sessionId}`)
    console.log(`  Mode: ${info.modeTitle}`)

    if (info.mcpToolCount > 0) {
      console.log(`  MCP: loaded ${info.mcpToolCount} tool(s) from ${info.mcpServerCount} server(s)`)
    }
    if (info.worktreePath) console.log(`  Worktree: ${info.worktreePath}`)
    if (info.resumedMessageCount !== undefined) console.log(`  Resumed messages: ${info.resumedMessageCount}`)
    if (this.verbose) console.log('  Verbose: enabled')
    for (const error of info.mcpErrors) console.log(`  [mcp] ${error}`)
    console.log()
  }

  renderEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.vlog(`-------- turn ${event.turn} --------`)
        this.startThinking()
        return
      case 'assistant_delta':
        this.stopThinking()
        if (!this.streaming) {
          this.vlog('model: text response')
          stdout.write(stdout.isTTY ? '助手 › ' : '\n助手 › ')
          this.streaming = true
        }
        stdout.write(event.text)
        return
      case 'assistant_text':
        this.stopThinking()
        if (!this.streaming && event.text) {
          stdout.write(stdout.isTTY ? `助手 › ${event.text}` : `\n助手 › ${event.text}`)
        }
        stdout.write('\n\n')
        this.streaming = false
        return
      case 'tool_start':
        this.stopThinking()
        this.closeStreamingLine()
        this.vlog(`tool: ${event.name} args=${JSON.stringify(event.args)}`)
        console.log(renderToolStart(event.name, event.args, stdout.isTTY))
        return
      case 'tool_result':
        console.log(renderToolResult(event.name, event.ok, event.content))
        this.vlog(`tool result: ${event.ok ? 'ok' : 'failed'}, ${event.content.length} chars`)
        return
      case 'error':
        this.stopThinking()
        console.log(`\n[出错] ${event.reason}\n`)
        return
      case 'max_turns':
        this.stopThinking()
        console.log('\n[提示] 达到最大轮次，已强制结束本轮。\n')
        return
    }
  }

  stopThinking(): void {
    if (!this.thinkingTimer) return
    clearInterval(this.thinkingTimer)
    this.thinkingTimer = null
    stdout.write('\r\x1b[K')
  }

  private startThinking(): void {
    if (!stdout.isTTY || this.thinkingTimer) return
    const frames = ['-', '\\', '|', '/']
    let i = 0
    this.thinkingTimer = setInterval(() => {
      stdout.write(`\r${frames[i++ % frames.length]} thinking...`)
    }, 90)
  }

  private closeStreamingLine(): void {
    if (!this.streaming) return
    stdout.write('\n')
    this.streaming = false
  }

  private vlog(line: string): void {
    if (this.verbose) console.log(`\x1b[90m  [verbose] ${line}\x1b[0m`)
  }
}

export function createCliRenderer(options: CliRendererOptions): CliRenderer {
  return new CliRenderer(options)
}

function renderToolStart(name: string, args: unknown, color: boolean): string {
  const input = asRecord(args)
  const lines = [`  -> ${toolTitle(name, input)}`]

  if (name === 'edit_file') {
    const path = stringArg(input.path, '(missing path)')
    const oldString = stringArg(input.old_string)
    const newString = stringArg(input.new_string)
    lines[0] = `  -> edit ${path}`
    lines.push(`     replace: ${input.replace_all === true ? 'all matches' : 'first unique match'}`)
    if (oldString !== undefined && newString !== undefined) {
      lines.push(indent(formatSimpleDiff(oldString, newString, { filePath: path, color, maxLines: 28 }), '     '))
    }
    return lines.join('\n')
  }

  if (name === 'write_file') {
    const path = stringArg(input.path, '(missing path)')
    const content = stringArg(input.content, '')
    lines[0] = `  -> write ${path}`
    lines.push(`     content: ${content.length.toLocaleString()} chars, ${lineCount(content).toLocaleString()} lines`)
    if (content.length > 0) {
      lines.push(indent(formatSimpleDiff('', content, { filePath: path, color, maxLines: 24 }), '     '))
    }
    return lines.join('\n')
  }

  if (name === 'run_command' || name === 'run_background_command') {
    lines[0] = name === 'run_command' ? '  -> run command' : '  -> start background command'
    lines.push(`     cwd: ${stringArg(input.cwd, '.')}`)
    lines.push(`     $ ${stringArg(input.command, '(missing command)')}`)
    const description = stringArg(input.description)
    if (description) lines.push(`     description: ${description}`)
    return lines.join('\n')
  }

  const summary = summarizeKnownTool(name, input)
  if (summary) lines.push(`     ${summary}`)
  return lines.join('\n')
}

function renderToolResult(name: string, ok: boolean, content: string): string {
  const status = ok ? 'ok' : 'failed'
  const lines = [`  ${ok ? '✓' : '✗'} ${name}: ${status}`]
  const preview = previewText(content, { maxChars: 900, maxLines: 8 })
  if (preview) lines.push(indent(preview, '     '))
  return lines.join('\n')
}

function toolTitle(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
      return `read ${stringArg(input.path, '(missing path)')}`
    case 'list_files':
      return `list ${stringArg(input.path, '.')}`
    case 'glob':
    case 'glob_files':
      return `glob ${stringArg(input.pattern, '(missing pattern)')}`
    case 'grep':
    case 'grep_code':
      return `grep ${stringArg(input.pattern, '(missing pattern)')}`
    case 'agent':
      return `sub-agent ${stringArg(input.subagent_type, 'general')}: ${stringArg(input.description, '')}`.trim()
    case 'task_list':
      return 'list background tasks'
    case 'task_output':
      return `read task output ${stringArg(input.task_id, '(missing task_id)')}`
    case 'task_stop':
      return `stop task ${stringArg(input.task_id, '(missing task_id)')}`
    case 'enter_worktree':
      return `enter worktree ${stringArg(input.name, '(auto)')}`
    case 'exit_worktree':
      return `exit worktree ${stringArg(input.action, '(missing action)')}`
    case 'exit_plan_mode':
      return 'submit plan for approval'
    default:
      if (name.startsWith('mcp__')) return `MCP ${name}`
      return name
  }
}

function summarizeKnownTool(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case 'agent':
      return previewText(stringArg(input.prompt, ''), { maxChars: 240, maxLines: 3 })
    case 'task_output':
      return `block=${input.block === true ? 'true' : 'false'}, max_chars=${numberArg(input.max_chars, 20000)}`
    case 'exit_plan_mode':
      return previewText(stringArg(input.plan, ''), { maxChars: 300, maxLines: 4 })
    default:
      return null
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringArg(value: unknown): string | undefined
function stringArg(value: unknown, fallback: string): string
function stringArg(value: unknown, fallback?: string): string | undefined {
  if (typeof value === 'string') return value
  return fallback
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function previewText(text: string, options: { maxChars: number; maxLines: number }): string {
  const rawLines = text.trimEnd().split('\n')
  const lines = rawLines.slice(0, options.maxLines)
  let preview = lines.join('\n')
  const lineOmitted = rawLines.length > options.maxLines

  if (preview.length > options.maxChars) {
    preview = `${preview.slice(0, options.maxChars)}...`
  } else if (lineOmitted) {
    preview += `\n... ${rawLines.length - options.maxLines} line(s) omitted ...`
  }

  return preview
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map(line => `${prefix}${line}`).join('\n')
}

function lineCount(content: string): number {
  if (content.length === 0) return 0
  return content.split('\n').length
}
