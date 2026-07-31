/**
 * tools/index.ts —— 工具注册表
 *
 * 解决什么问题：
 *   把散落的各个工具（readFile / listFiles / runCommand）收集到一处，
 *   并提供"按名字查找工具"的能力。loop 和执行管线都从这里拿工具，
 *   而不用各自 import 一堆工具文件。
 *
 * 对应 Claude Code：src/tools.ts —— 工具注册表（getTools）。
 *
 * 加新工具时，只需在这里 import 并加进 allTools 数组，别处不用动。
 */

import type { Tool } from '../types.js'
import { readFileTool } from './readFile.js'
import { listFilesTool } from './listFiles.js'
import { runCommandTool } from './runCommand.js'
import { globFilesTool } from './globFiles.js'
import { grepCodeTool } from './grepCode.js'
import { writeFileTool } from './writeFile.js'
import { editFileTool } from './editFile.js'
import { useSkillTool } from './useSkill.js'
import { agentTool } from './agent.js'
import { exitPlanModeTool } from './exitPlanMode.js'
import { runBackgroundCommandTool } from './runBackgroundCommand.js'
import { taskListTool } from './taskList.js'
import { taskOutputTool } from './taskOutput.js'
import { taskStopTool } from './taskStop.js'
import { enterWorktreeTool } from './enterWorktree.js'
import { exitWorktreeTool } from './exitWorktree.js'

/** 内置工具。加新的内置工具 = 往这里加一个。 */
const builtInTools: Tool[] = [
  readFileTool,
  listFilesTool,
  globFilesTool,
  grepCodeTool,
  writeFileTool,
  editFileTool,
  useSkillTool,
  agentTool,
  exitPlanModeTool,
  taskListTool,
  taskOutputTool,
  taskStopTool,
  enterWorktreeTool,
  exitWorktreeTool,
  runBackgroundCommandTool,
  runCommandTool,
]

let externalTools: Tool[] = []

/** 注册 MCP 等运行时发现的外部工具。 */
export function setExternalTools(tools: Tool[]): void {
  externalTools = tools
}

/** 所有当前可用工具：内置工具 + 运行时外部工具。 */
export function getAllTools(): Tool[] {
  return [...builtInTools, ...externalTools]
}

/** 按名字查找工具。找不到返回 undefined。 */
export function findTool(name: string): Tool | undefined {
  return getAllTools().find(t => t.name === name)
}
