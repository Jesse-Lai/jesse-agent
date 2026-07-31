/**
 * exitPlanMode.ts - request approval to leave Plan mode and start execution.
 *
 * Simplified Claude Code ExitPlanMode:
 * - model provides final plan as a parameter
 * - tool saves it to .jesse/plans/<session>.md
 * - user approves/rejects
 * - approved => acceptEdits, rejected => stay in plan
 */

import type { Tool } from '../types.js'
import { exitPlanModeWithApproval } from '../planMode.js'

export const exitPlanModeTool: Tool = {
  name: 'exit_plan_mode',

  description:
    'Use only in Plan mode when the implementation plan is complete and ready for user approval. ' +
    'Saves the plan, asks the user to approve it, and if approved switches to Accept Edits mode so implementation can begin. ' +
    'Do not use this for pure research tasks that do not require code changes.',

  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'The complete implementation plan. Include context, files to change, approach, risks, and verification steps.',
      },
    },
    required: ['plan'],
  },

  isReadOnly: false,

  async execute(args) {
    const plan = String(args.plan ?? '').trim()
    if (!plan) return '错误：未提供 plan 参数。'

    const result = await exitPlanModeWithApproval(plan)
    if (!result.approved) {
      return [
        '用户拒绝了该计划。',
        `计划已保存到：${result.planFilePath}`,
        '仍保持 Plan 模式。请根据用户反馈继续澄清或修改计划，然后再次调用 exit_plan_mode。',
      ].join('\n')
    }

    return [
      '用户已批准该计划。现在可以开始执行。',
      `计划已保存到：${result.planFilePath}`,
      '权限模式已切换到 Accept Edits：文件编辑会自动允许；Bash 仍按权限规则处理。',
      '',
      'Approved Plan:',
      result.plan,
    ].join('\n')
  },
}
