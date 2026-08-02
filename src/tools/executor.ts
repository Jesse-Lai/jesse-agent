/**
 * executor.ts —— 工具执行管线（🔑 承重设计）
 *
 * 解决什么问题：
 *   模型说"我要调 run_command"之后，不能"抓到工具就跑"。真实的 agent 会
 *   走一条三步安检管线，把危险挡在执行之前：
 *
 *       validate（校验参数）→ permission（权限确认）→ call（真正执行）
 *
 *   validate 和 permission 已逐步填实：参数校验、权限模式、会话规则、
 *   只读 Bash 分类、y/a/n 人工确认都挂在这条管线上。
 *
 * 对应 Claude Code：
 *   src/services/tools/toolExecution.ts 的 runToolUse / checkPermissionsAndCallTool，
 *   同样是 validateInput → checkPermissions → tool.call 三步。
 */

import type { Tool } from '../types.js'
import type { AgentRuntimeContext } from '../runtimeContext.js'
import { findTool } from './index.js'
import { confirm } from '../confirm.js'
import { budgetToolResult } from '../contextBudget.js'
import { checkPermission, describeRule, rememberSessionAllowRule } from '../permissions.js'
import { isPathWithinProjectRoot, resolveWorkingDirectory } from '../workingDirectory.js'
import { classifyBashCommand } from '../bashClassifier.js'
import { getPermissionMode, permissionModeTitle } from '../permissionMode.js'
import { buildToolApprovalRequest, type ToolApprovalRequest } from '../toolApprovals.js'

/** 执行结果：成功带内容，失败带原因（都会被喂回给模型）。 */
export interface ExecuteResult {
  ok: boolean
  content: string
  /** Stop the current agent run after reporting this result. */
  stop?: boolean
}

export interface ExecuteToolOptions {
  tools?: Tool[]
  context?: AgentRuntimeContext
}

interface PermissionOutcome {
  result: ExecuteResult | null
  toolResultPrefix?: string
}

// ============================================================================
// 三步管线的每一步
// ============================================================================

/**
 * 第 1 步 · validate —— 校验参数是否合法。
 * 这里读每个工具自己的 parameters(JSON Schema 极简版)：
 *   - required 里的参数必须存在
 *   - 传进来的参数类型必须和 schema.properties 里声明的一致
 *   - 必填字符串不能是空字符串
 *
 * 不合法时返回错误文本给模型，而不是执行工具。这样模型能看到
 * "错在哪里"，下一轮自己修正参数。
 */
async function validate(
  tool: Tool,
  args: Record<string, unknown>,
  context?: AgentRuntimeContext,
): Promise<ExecuteResult | null> {
  const errors: string[] = []
  const required = tool.parameters.required ?? []

  for (const name of required) {
    if (!(name in args) || args[name] === null || args[name] === undefined) {
      errors.push(`缺少必填参数 "${name}"`)
      continue
    }

    if (typeof args[name] === 'string' && args[name].trim() === '') {
      errors.push(`参数 "${name}" 不能为空字符串`)
    }
  }

  for (const [name, value] of Object.entries(args)) {
    // 模型偶尔会多给参数；目前先宽容忽略，避免把无害信息当成硬错误。
    const property = tool.parameters.properties[name]
    if (!property || value === null || value === undefined) continue

    if (!matchesSchemaType(value, property.type)) {
      errors.push(
        `参数 "${name}" 类型错误：期望 ${describeExpectedType(property.type)}，实际是 ${describeValueType(value)}`,
      )
    }

    if (schemaAllowsString(property.type) && typeof value === 'string' && value.trim() === '') {
      errors.push(`参数 "${name}" 不能为空字符串`)
    }
  }

  if (errors.length === 0 && isShellCommandTool(tool.name)) {
    try {
      await resolveWorkingDirectory(args.cwd, context)
    } catch (err) {
      errors.push(`参数 "cwd" 不合法：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      content: `工具 "${tool.name}" 参数校验失败：${errors.join('；')}。请修正参数后重试。`,
    }
  }

  // 返回 null 表示"校验通过，继续下一步"。
  return null
}

function matchesSchemaType(value: unknown, expected: unknown): boolean {
  if (!expected) return true
  if (Array.isArray(expected)) return expected.some(type => matchesSchemaType(value, type))
  if (typeof expected !== 'string') return true

  switch (expected) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true
  }
}

function schemaAllowsString(expected: unknown): boolean {
  if (expected === 'string') return true
  return Array.isArray(expected) && expected.includes('string')
}

function describeExpectedType(expected: unknown): string {
  if (Array.isArray(expected)) return expected.join(' | ')
  if (typeof expected === 'string') return expected
  return 'unknown'
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * 第 2 步 · permission —— 是否需要用户确认。
 *
 * 规则（靠工具的 isReadOnly 分流）：
 *   - 只读工具（read_file / list_files）：直接放行，不打扰用户。
 *   - 危险工具（run_command 等）：先查权限规则，再视情况问用户 y/a/n。
 *     y → 放行一次；a → 本次会话记住 allow 规则；n → 返回"用户拒绝"给模型。
 */
async function permission(
  tool: Tool,
  args: Record<string, unknown>,
  context?: AgentRuntimeContext,
): Promise<PermissionOutcome> {
  const mode = getPermissionMode()

  if (mode === 'bypassPermissions') {
    console.log(`\n⚠️  ${permissionModeTitle(mode)} 模式：跳过权限确认。`)
    return continueWithoutPermissionNote()
  }

  if (mode === 'plan') {
    return resultFromPermissionCheck(permissionInPlanMode(tool, args))
  }

  // 只读工具无副作用，无需确认。
  if (tool.isReadOnly) return continueWithoutPermissionNote()

  let detail = ''
  let approvalRequest: ToolApprovalRequest | null = null

  if (isFileEditTool(tool.name)) {
    detail = describeDangerousAction(tool.name, args)
    approvalRequest = await buildToolApprovalRequest(tool.name, args, detail, context)
    if (approvalRequest.noChanges) {
      return resultFromPermissionCheck({ ok: true, content: noChangesContent(tool.name, approvalRequest.files) })
    }
  }

  if (mode === 'acceptEdits' && isFileEditTool(tool.name)) {
    if (isPathWithinProjectRoot(args.path, context)) {
      console.log(`\n✅ ${permissionModeTitle(mode)} 模式：自动允许项目内文件编辑工具 ${tool.name}。`)
      return continueWithoutPermissionNote()
    }
    console.log(`\n⚠️  ${permissionModeTitle(mode)} 模式不会自动允许项目外文件编辑，改走正常确认。`)
  }

  const decision = checkPermission(tool.name, args)
  if (decision.behavior === 'allow') {
    if (decision.reason) console.log(`\n✅ ${decision.reason}`)
    return continueWithoutPermissionNote()
  }

  if (decision.behavior === 'deny') {
    return resultFromPermissionCheck({ ok: false, content: `权限系统拒绝了此操作：${decision.reason ?? '命中 deny 规则。'}` })
  }

  // 危险工具：组织一句人类可读的动作说明，尽量展示"具体要干什么"。
  // run_command 展示命令本身；其他危险工具展示工具名 + 参数。
  if (!detail) detail = describeDangerousAction(tool.name, args)

  if (!approvalRequest) approvalRequest = await buildToolApprovalRequest(tool.name, args, detail, context)
  const choice = context?.approvalHandler
    ? await context.approvalHandler(approvalRequest)
    : await confirm(detail)
  if (choice === 'allow_once') {
    return continueWithApprovalNote(tool.name, 'allow_once')
  }

  if (choice === 'allow_for_session') {
    const rule = rememberSessionAllowRule(tool.name, args)
    console.log(`✅ 已记住本次会话规则：${describeRule(rule)}`)
    return continueWithApprovalNote(tool.name, 'allow_for_session')
  }

  // 用户拒绝 → 中止当前 agent run，避免模型下一轮重复请求同一个危险操作。
  return resultFromPermissionCheck({ ok: false, content: '用户拒绝了此操作，已停止当前运行。', stop: true })
}

function continueWithoutPermissionNote(): PermissionOutcome {
  return { result: null }
}

function continueWithApprovalNote(toolName: string, choice: 'allow_once' | 'allow_for_session'): PermissionOutcome {
  const choiceText = choice === 'allow_once' ? 'allow once' : 'allow for session'
  return {
    result: null,
    toolResultPrefix: [
      '[Permission]',
      `This ${toolName} call required user approval. The user selected: ${choiceText}.`,
    ].join('\n'),
  }
}

function resultFromPermissionCheck(result: ExecuteResult | null): PermissionOutcome {
  return { result }
}

function permissionInPlanMode(tool: Tool, args: Record<string, unknown>): ExecuteResult | null {
  if (tool.isReadOnly) return null

  if (tool.name === 'exit_plan_mode') return null

  if (isShellCommandTool(tool.name) && typeof args.command === 'string') {
    const classification = classifyBashCommand(args.command)
    if (classification.risk === 'read_only') {
      console.log(`\n✅ Plan 模式：允许只读 Bash 命令。${classification.reason}`)
      return null
    }
  }

  return {
    ok: false,
    content: `Plan 模式禁止执行会修改系统或不确定是否只读的工具：${tool.name}。请先完成计划，切换到 default 或 acceptEdits 后再执行。`,
  }
}

function isFileEditTool(toolName: string): boolean {
  return toolName === 'write_file' || toolName === 'edit_file'
}

function isShellCommandTool(toolName: string): boolean {
  return toolName === 'run_command' || toolName === 'run_background_command'
}

function noChangesContent(toolName: string, files?: string[]): string {
  const target = files && files.length > 0 ? `：${files.join(', ')}` : ''
  return `没有实际改动${target}。已跳过 ${toolName}，未执行写入，也不需要审批。`
}

function describeDangerousAction(toolName: string, args: Record<string, unknown>): string {
  if (typeof args.command === 'string') {
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '.'
    return [`即将执行命令：${args.command}`, `执行目录 cwd：${cwd}`].join('\n')
  }

  if (toolName === 'write_file') {
    const content = String(args.content ?? '')
    return [
      `即将写入文件：${String(args.path ?? '')}`,
      `内容规模：${content.length.toLocaleString()} 字符，${lineCount(content).toLocaleString()} 行`,
      `内容预览：${previewText(content)}`,
    ].join('\n')
  }

  if (toolName === 'edit_file') {
    return [
      `即将编辑文件：${String(args.path ?? '')}`,
      `replace_all：${args.replace_all === true ? 'true' : 'false'}`,
      `old_string：${previewText(String(args.old_string ?? ''))}`,
      `new_string：${previewText(String(args.new_string ?? ''))}`,
    ].join('\n')
  }

  if (toolName === 'agent') {
    return [
      `即将启动子 agent：${String(args.subagent_type ?? 'general')}`,
      `description：${String(args.description ?? '')}`,
      `run_in_background：${args.run_in_background === true ? 'true' : 'false'}`,
      `isolation：${String(args.isolation ?? '(none)')}`,
      `prompt：${previewText(String(args.prompt ?? ''), 500)}`,
    ].join('\n')
  }

  if (toolName === 'exit_plan_mode') {
    return [
      '即将提交计划并请求用户批准。',
      `plan：${previewText(String(args.plan ?? ''), 700)}`,
    ].join('\n')
  }

  if (toolName === 'task_stop') {
    return `即将停止后台任务：${String(args.task_id ?? '')}`
  }

  if (toolName === 'task_continue') {
    return [
      `即将继续后台 agent task：${String(args.task_id ?? '')}`,
      `prompt：${previewText(String(args.prompt ?? ''), 500)}`,
    ].join('\n')
  }

  if (toolName === 'enter_worktree') {
    return [
      '即将创建并进入隔离 git worktree。',
      `name：${String(args.name ?? '(auto)')}`,
      '之后相对路径的读写和命令默认会在 worktree 中执行。',
    ].join('\n')
  }

  if (toolName === 'exit_worktree') {
    return [
      '即将退出当前 worktree session。',
      `action：${String(args.action ?? '')}`,
      `discard_changes：${args.discard_changes === true ? 'true' : 'false'}`,
    ].join('\n')
  }

  return `即将执行危险工具 "${toolName}"，参数：${JSON.stringify(args)}`
}

function previewText(text: string, maxChars = 300): string {
  const normalized = text.replaceAll('\n', '\\n')
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}...`
}

function lineCount(content: string): number {
  if (content.length === 0) return 0
  return content.split('\n').length
}

/**
 * 第 3 步 · call —— 真正执行工具。
 */
async function call(
  tool: Tool,
  args: Record<string, unknown>,
  context?: AgentRuntimeContext,
  prefix?: string,
): Promise<ExecuteResult> {
  const content = await tool.execute(args, context)
  const budgeted = await budgetToolResult(tool.name, content)
  return { ok: true, content: prefix ? `${prefix}\n\n[Tool output]\n${budgeted}` : budgeted }
}

// ============================================================================
// 管线入口
// ============================================================================

/**
 * 执行一个工具：按名字找到它，然后走 validate → permission → call。
 *
 * @param name 工具名（模型给的）
 * @param args 参数（模型给的，已解析成对象）
 * @returns    ExecuteResult：结果会被喂回给模型
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  options: ExecuteToolOptions = {},
): Promise<ExecuteResult> {
  // 先按名字找工具。找不到也返回文本（而非抛异常），让模型知道"没这个工具"。
  const tool = options.tools
    ? options.tools.find(candidate => candidate.name === name)
    : findTool(name)
  if (!tool) {
    return { ok: false, content: `错误：当前工具池中找不到名为 "${name}" 的工具` }
  }

  // 三步管线整体包一层兜底 try/catch（Step 10 · 优雅降级）：
  // 万一某个工具忘了自己 catch、或权限确认那步抛了异常，就把"意外崩溃"降级成
  // 一条错误结果喂回模型，而不是让整个 agentic loop 崩掉。
  try {
    // 第 1 步：校验。任一步返回非 null，就在此中止并把结果交出去。
    const validateResult = await validate(tool, args, options.context)
    if (validateResult) return validateResult

    // 第 2 步：权限。
    const permissionOutcome = await permission(tool, args, options.context)
    if (permissionOutcome.result) return permissionOutcome.result

    // 第 3 步：执行。
    return await call(tool, args, options.context, permissionOutcome.toolResultPrefix)
  } catch (err) {
    return {
      ok: false,
      content: `工具执行意外出错：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
