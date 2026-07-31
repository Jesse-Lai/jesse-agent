/**
 * exitWorktree.ts - leave the current worktree session.
 */

import type { Tool } from '../types.js'
import { exitWorktree } from '../worktrees.js'

export const exitWorktreeTool: Tool = {
  name: 'exit_worktree',

  description:
    '退出 enter_worktree 创建的当前 worktree session，并回到原始工作目录。' +
    'action="keep" 会保留 worktree 目录和分支；action="remove" 会删除 worktree 和临时分支。' +
    '如果 remove 会丢弃未提交文件或独立 commit，工具会拒绝，除非 discard_changes=true。',

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description: 'keep=保留 worktree；remove=删除 worktree 和临时分支。',
      },
      discard_changes: {
        type: 'boolean',
        description: '仅 action=remove 时有效。为 true 表示确认丢弃 worktree 内未提交文件或独立 commit。',
      },
    },
    required: ['action'],
  },

  isReadOnly: false,

  async execute(args) {
    const action = String(args.action ?? '').trim()
    if (action !== 'keep' && action !== 'remove') return '错误：action 必须是 keep 或 remove。'

    const result = await exitWorktree({
      action,
      discardChanges: args.discard_changes === true,
    })

    const lines = [
      `exited: ${result.exited}`,
      `action: ${result.action}`,
      result.session ? `worktree_path: ${result.session.worktreePath}` : '',
      result.session ? `worktree_branch: ${result.session.worktreeBranch}` : '',
      result.changedFiles !== undefined ? `changed_files: ${result.changedFiles}` : '',
      result.commits !== undefined ? `commits: ${result.commits}` : '',
      '',
      result.message,
    ].filter(Boolean)

    return lines.join('\n')
  },
}
