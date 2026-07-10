/**
 * executor.ts —— 工具执行管线（🔑 承重设计）
 *
 * 解决什么问题：
 *   模型说"我要调 run_command"之后，不能"抓到工具就跑"。真实的 agent 会
 *   走一条三步安检管线，把危险挡在执行之前：
 *
 *       validate（校验参数）→ permission（权限确认）→ call（真正执行）
 *
 *   现在 validate 和 permission 先是【空桩】（直接放行），但三道关卡的
 *   位置先立好。后续 Phase 往里填，不用改结构：
 *     - Step 6.5  → 填 permission（危险工具 y/n 确认）
 *     - Phase 4   → 填 validate（参数校验，非法就退回原因给模型）
 *
 * 对应 Claude Code：
 *   src/services/tools/toolExecution.ts 的 runToolUse / checkPermissionsAndCallTool，
 *   同样是 validateInput → checkPermissions → tool.call 三步。
 */

import type { Tool } from '../types.js'
import { findTool } from './index.js'
import { confirm } from '../confirm.js'

/** 执行结果：成功带内容，失败带原因（都会被喂回给模型）。 */
export interface ExecuteResult {
  ok: boolean
  content: string
}

// ============================================================================
// 三步管线的每一步
// ============================================================================

/**
 * 第 1 步 · validate —— 校验参数是否合法。
 * 现在是空桩：一律通过。Phase 4 会在这里做真正的参数检查
 * （比如 read_file 的 path 必须存在、类型对等），不合法就返回原因，
 * 让模型看到"为什么失败"并自己调整。
 */
async function validate(_tool: Tool, _args: Record<string, unknown>): Promise<ExecuteResult | null> {
  // 返回 null 表示"校验通过，继续下一步"。
  return null
}

/**
 * 第 2 步 · permission —— 是否需要用户确认。🔒 Step 6.5 已填。
 *
 * 规则（靠工具的 isReadOnly 分流）：
 *   - 只读工具（read_file / list_files）：直接放行，不打扰用户。
 *   - 危险工具（run_command 等）：把要执行的动作打印出来，问用户 y/n。
 *     同意 → 放行；拒绝 → 返回"用户拒绝"文本给模型（方案 A），
 *     让模型看到这条路走不通、自己调整策略。
 */
async function permission(tool: Tool, args: Record<string, unknown>): Promise<ExecuteResult | null> {
  // 只读工具无副作用，无需确认。
  if (tool.isReadOnly) return null

  // 危险工具：组织一句人类可读的动作说明，尽量展示"具体要干什么"。
  // run_command 展示命令本身；其他危险工具展示工具名 + 参数。
  const detail =
    typeof args.command === 'string'
      ? `即将执行命令：${args.command}`
      : `即将执行危险工具 "${tool.name}"，参数：${JSON.stringify(args)}`

  const allowed = await confirm(detail)
  if (allowed) return null // 用户同意 → 继续执行

  // 用户拒绝 → 中止执行，把拒绝信息作为结果返回给模型。
  return { ok: false, content: '用户拒绝了此操作。' }
}

/**
 * 第 3 步 · call —— 真正执行工具。
 */
async function call(tool: Tool, args: Record<string, unknown>): Promise<ExecuteResult> {
  const content = await tool.execute(args)
  return { ok: true, content }
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
): Promise<ExecuteResult> {
  // 先按名字找工具。找不到也返回文本（而非抛异常），让模型知道"没这个工具"。
  const tool = findTool(name)
  if (!tool) {
    return { ok: false, content: `错误：找不到名为 "${name}" 的工具` }
  }

  // 三步管线整体包一层兜底 try/catch（Step 10 · 优雅降级）：
  // 万一某个工具忘了自己 catch、或权限确认那步抛了异常，就把"意外崩溃"降级成
  // 一条错误结果喂回模型，而不是让整个 agentic loop 崩掉。
  try {
    // 第 1 步：校验。任一步返回非 null，就在此中止并把结果交出去。
    const validateResult = await validate(tool, args)
    if (validateResult) return validateResult

    // 第 2 步：权限。
    const permissionResult = await permission(tool, args)
    if (permissionResult) return permissionResult

    // 第 3 步：执行。
    return await call(tool, args)
  } catch (err) {
    return {
      ok: false,
      content: `工具执行意外出错：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
