/**
 * taskContinue.ts - continue a completed background agent task.
 */

import type { Tool } from '../types.js'
import { formatTaskDetails } from '../taskDisplay.js'
import { continueAgentTask, getTask } from '../tasks.js'
import { restoreBackgroundAgentTask } from './agent.js'

export const taskContinueTool: Tool = {
  name: 'task_continue',

  description:
    '继续一个已经完成的后台 agent task。参数 task_id 和 prompt 必填。' +
    '如果 CLI 已重启且该 task 不在内存中，会尝试从 .jesse/task-output/<task-id>.messages.jsonl 和 metadata 恢复。',

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

    if (!getTask(taskId)) {
      await restoreBackgroundAgentTask(taskId)
    }

    const task = await continueAgentTask(taskId, prompt)
    return [
      'Background agent continuation started.',
      formatTaskDetails(task),
      '',
      'Use task_output with this task_id to read the continued result later.',
    ].join('\n')
  },
}
