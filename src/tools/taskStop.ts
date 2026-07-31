/**
 * taskStop.ts - stop a running background task.
 */

import type { Tool } from '../types.js'
import { formatTaskDetails } from '../taskDisplay.js'
import { stopTask } from '../tasks.js'

export const taskStopTool: Tool = {
  name: 'task_stop',

  description:
    '停止一个正在运行的后台任务。参数 task_id 必填。' +
    '支持停止 shell 后台任务，也支持取消后台 sub-agent。',

  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '要停止的后台任务 ID' },
    },
    required: ['task_id'],
  },

  isReadOnly: false,

  async execute(args) {
    const taskId = String(args.task_id ?? '').trim()
    if (!taskId) return '错误：未提供 task_id 参数。'

    const task = await stopTask(taskId)
    return [
      'Background task stop requested.',
      formatTaskDetails(task),
    ].join('\n')
  },
}
