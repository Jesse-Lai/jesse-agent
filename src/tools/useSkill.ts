/**
 * useSkill.ts - load a reusable SKILL.md on demand
 *
 * This is the simplified Claude Code SkillTool. The prompt lists available
 * skills, but the full Markdown instructions are loaded only when the model
 * calls this tool.
 */

import type { Tool } from '../types.js'
import { loadSkill } from '../skills.js'

export const useSkillTool: Tool = {
  name: 'use_skill',

  description:
    '按需加载一个可复用技能的完整 SKILL.md 内容。' +
    '当当前任务明显匹配系统提示词里列出的 skill 时，先调用这个工具，再按返回的技能说明继续执行。' +
    '参数 name 是技能名；args 是可选参数字符串，会原样展示给模型参考。',

  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '要加载的技能名，例如 verify-project' },
      args: { type: 'string', description: '可选。传给技能的参数文本；当前版本只展示，不做模板替换。' },
    },
    required: ['name'],
  },

  isReadOnly: true,

  async execute(args) {
    const name = String(args.name ?? '').trim()
    if (!name) return '错误：未提供 name 参数'

    const loaded = await loadSkill(name)
    if (typeof loaded === 'string') return loaded

    const skillArgs = typeof args.args === 'string' && args.args.trim()
      ? args.args.trim()
      : null

    return [
      `已加载技能：${loaded.name}`,
      `来源：${loaded.source}`,
      `技能文件：${loaded.path}`,
      `技能目录：${loaded.baseDir}`,
      skillArgs ? `调用参数：${skillArgs}` : null,
      '',
      '--- SKILL.md ---',
      loaded.content.trim(),
    ].filter((line): line is string => line !== null).join('\n')
  },
}
