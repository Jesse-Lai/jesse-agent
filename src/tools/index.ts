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

/** 所有已注册的工具。加新工具 = 往这里加一个。 */
export const allTools: Tool[] = [readFileTool, listFilesTool, runCommandTool]

/** 按名字查找工具。找不到返回 undefined。 */
export function findTool(name: string): Tool | undefined {
  return allTools.find(t => t.name === name)
}
