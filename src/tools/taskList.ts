/**
 * taskList.ts - list known background tasks.
 */

import type { Tool } from '../types.js'
import { listTasks, type TaskSnapshot } from '../tasks.js'

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

    return tasks.map(formatTaskLine).join('\n')
  },
}

function formatTaskLine(task: TaskSnapshot): string {
  const stale = task.stale ? ` stale="${task.staleReason}"` : ''
  const exit = task.exitCode === undefined ? '' : ` exit_code=${task.exitCode}`
  const signal = task.signal ? ` signal=${task.signal}` : ''
  return [
    `- ${task.id}`,
    `[${task.status}]`,
    `kind=${task.kind}`,
    `duration_ms=${task.durationMs}`,
    `description="${task.description}"`,
    `output_path=${task.outputPath}`,
    task.command ? `command="${task.command}"` : '',
    task.cwd ? `cwd=${task.cwd}` : '',
    exit,
    signal,
    stale,
  ].filter(Boolean).join(' ')
}
