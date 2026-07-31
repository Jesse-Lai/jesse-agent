/**
 * taskContinue.ts - continue a completed background agent task.
 */

import type { Tool } from '../types.js'
import { formatTaskDetails } from '../taskDisplay.js'
import { continueAgentTask } from '../tasks.js'

export const taskContinueTool: Tool = {
  name: 'task_continue',

  description:
    '继续一个已经完成的后台 agent task。参数 task_id 和 prompt 必填。' +
    '当前版本支持当前进程内的后台 agent continuation；重启后的跨进程 resume 会作为后续扩展。',

  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '要继续对话的后台 agent task ID' },
      prompt: { type: 'string', description: '追加给该后台 agent 的新用户消息/追问' },
    },
    required: ['task_id', 'prompt'],
  },

  isReadOnly: false,

  async execute(args) {
    const taskId = String(args.task_id ?? '').trim()
    const prompt = String(args.prompt ?? '').trim()
    if (!taskId) return '错误：未提供 task_id 参数。'
    if (!prompt) return '错误：未提供 prompt 参数。'

    const task = await continueAgentTask(taskId, prompt)
    return [
      'Background agent continuation started.',
      formatTaskDetails(task),
      '',
      'Use task_output with this task_id to read the continued result later.',
    ].join('\n')
  },
}
