/**
 * taskOutput.ts - read output from a background task.
 */

import type { Tool } from '../types.js'
import { formatTaskDetails } from '../taskDisplay.js'
import { readTaskOutput } from '../tasks.js'

export const taskOutputTool: Tool = {
  name: 'task_output',

  description:
    '读取后台任务的输出和状态。参数 task_id 必填。' +
    'block=true 时会等待任务完成或等待到 timeout_ms；block=false 时立即返回当前输出。' +
    'max_chars 控制最多返回多少尾部字符，默认 20000。',

  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '要读取输出的后台任务 ID' },
      block: { type: 'boolean', description: '可选。是否等待任务完成，默认 false。' },
      timeout_ms: { type: 'number', description: '可选。block=true 时最多等待多少毫秒，默认 30000。' },
      max_chars: { type: 'number', description: '可选。最多返回输出尾部多少字符，默认 20000。' },
    },
    required: ['task_id'],
  },

  isReadOnly: true,

  async execute(args) {
    const taskId = String(args.task_id ?? '').trim()
    if (!taskId) return '错误：未提供 task_id 参数。'

    const result = await readTaskOutput(taskId, {
      block: args.block === true,
      timeoutMs: parsePositiveNumber(args.timeout_ms, 30_000),
      maxChars: parsePositiveNumber(args.max_chars, 20_000),
    })

    const lines = [formatTaskDetails(result.snapshot, result.retrievalStatus)]
    lines.push('', '--- output ---', result.output.trimEnd() || '(no output yet)')
    return lines.join('\n')
  },
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}
