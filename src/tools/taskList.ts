/**
 * taskList.ts - list known background tasks.
 */

import type { Tool } from '../types.js'
import { formatTaskLine } from '../taskDisplay.js'
import { listTasks } from '../tasks.js'

export const taskListTool: Tool = {
  name: 'task_list',

  description:
    '列出当前进程内已知的后台任务，包括 task_id、状态、类型、说明、运行时长和输出文件。' +
    '用于找到后续 task_output 或 task_stop 需要的 task_id。',

  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },

  isReadOnly: true,

  async execute() {
    const tasks = listTasks()
    if (tasks.length === 0) return 'No background tasks found.'

    return tasks.map(formatTaskLine).join('\n\n')
  },
}
