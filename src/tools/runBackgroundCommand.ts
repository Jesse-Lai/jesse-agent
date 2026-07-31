/**
 * runBackgroundCommand.ts - start a long-running shell command as a task.
 */

import type { Tool } from '../types.js'
import { formatTaskDetails } from '../taskDisplay.js'
import { startShellTask, type TaskSnapshot } from '../tasks.js'

export const runBackgroundCommandTool: Tool = {
  name: 'run_background_command',

  description:
    '在后台启动一条可能运行较久的 shell 命令，立即返回 task_id，不等待命令完成。' +
    '适合运行长测试、长构建、watch 之外的长检查或后台调查。' +
    '参数 command 是要执行的命令；cwd 可选，必须位于项目目录内；description 可选，用于描述任务。' +
    '之后用 task_output 读取输出，用 task_list 查看任务，用 task_stop 停止任务。',

  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要在后台执行的 shell 命令' },
      cwd: { type: 'string', description: '可选。命令执行目录，必须位于项目目录内；默认是项目根目录。' },
      description: { type: 'string', description: '可选。3-8 个词的任务说明，方便之后在 task_list 中识别。' },
    },
    required: ['command'],
  },

  isReadOnly: false,

  async execute(args) {
    const command = String(args.command ?? '').trim()
    if (!command) return '错误：未提供 command 参数。'

    const task = await startShellTask({
      command,
      cwd: args.cwd,
      description: typeof args.description === 'string' ? args.description : undefined,
    })

    return formatStartedTask(task)
  },
}

function formatStartedTask(task: TaskSnapshot): string {
  return [
    'Background task started.',
    formatTaskDetails(task),
    '',
    'Use task_output with this task_id to read output later. Use task_stop to stop it if needed.',
  ].join('\n')
}
