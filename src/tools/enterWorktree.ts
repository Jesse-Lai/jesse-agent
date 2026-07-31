/**
 * enterWorktree.ts - create an isolated git worktree and switch this session into it.
 */

import type { Tool } from '../types.js'
import { enterWorktree, type WorktreeSession } from '../worktrees.js'

export const enterWorktreeTool: Tool = {
  name: 'enter_worktree',

  description:
    '创建一个隔离 git worktree，并把当前 session 的工作目录切换进去。' +
    '只在用户明确要求使用 worktree，或先向用户说明风险并得到同意后使用。' +
    '参数 name 可选，只能包含字母、数字、点、下划线和短横线；不传会自动生成。' +
    '进入后，read_file/list_files/write_file/edit_file/run_command 等工具默认都在 worktree 内工作。',

  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '可选。worktree 名称，只能包含字母、数字、点、下划线和短横线，最多 64 字符。',
      },
    },
    required: [],
  },

  isReadOnly: false,

  async execute(args) {
    const session = await enterWorktree({ name: args.name })
    return formatWorktreeEntered(session)
  },
}

function formatWorktreeEntered(session: WorktreeSession): string {
  return [
    'Entered worktree session.',
    `worktree_path: ${session.worktreePath}`,
    `worktree_branch: ${session.worktreeBranch}`,
    `original_cwd: ${session.originalCwd}`,
    `original_head: ${session.originalHeadCommit}`,
    '',
    'All relative file and shell operations now default to this worktree. Use exit_worktree with action="keep" or action="remove" when done.',
  ].join('\n')
}
