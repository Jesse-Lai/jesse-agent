/**
 * skills.ts - progressive skill discovery (Phase 7 / Step 20)
 *
 * A skill is a reusable Markdown playbook at:
 *   .jesse/skills/<skill-name>/SKILL.md
 *   .claude/skills/<skill-name>/SKILL.md
 *
 * Like Claude Code, we keep normal context small by exposing only a manifest
 * (name/description/when_to_use). The full SKILL.md is loaded only when the
 * model calls the use_skill tool.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentRuntimeContext } from './runtimeContext.js'
import { getProjectRoot } from './workingDirectory.js'

export const SKILL_DIRS = ['.jesse/skills', '.claude/skills'] as const

const SKILL_FILE_NAME = 'SKILL.md'
const FRONTMATTER_MAX_LINES = 60
const MAX_SKILLS = 200
const MAX_LISTING_DESC_CHARS = 250

export interface SkillHeader {
  name: string
  path: string
  baseDir: string
  source: '.jesse' | '.claude'
  description: string
  whenToUse: string | null
  mtimeMs: number
}

export interface LoadedSkill extends SkillHeader {
  content: string
}

export interface SkillsContext {
  skillDirs: readonly string[]
  skills: SkillHeader[]
  manifest: string
  error?: string
}

export async function loadSkillsContext(context?: AgentRuntimeContext): Promise<SkillsContext> {
  try {
    const skills = await scanSkills(context)
    return {
      skillDirs: SKILL_DIRS,
      skills,
      manifest: formatSkillManifest(skills),
    }
  } catch (err) {
    return {
      skillDirs: SKILL_DIRS,
      skills: [],
      manifest: '(skills unavailable)',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function loadSkill(name: string, context?: AgentRuntimeContext): Promise<LoadedSkill | string> {
  const normalizedName = normalizeSkillName(name)
  if (!normalizedName) return '技能名不能为空。'

  const skills = await scanSkills(context)
  const skill = skills.find(candidate => candidate.name === normalizedName)
  if (!skill) {
    const available = skills.length > 0 ? skills.map(s => s.name).join(', ') : '(none)'
    return `找不到技能 "${normalizedName}"。当前可用技能：${available}`
  }

  try {
    const content = await readFile(join(context?.projectRoot ?? getProjectRoot(), skill.path), 'utf8')
    return { ...skill, content }
  } catch (err) {
    return `读取技能 "${normalizedName}" 失败：${err instanceof Error ? err.message : String(err)}`
  }
}

export async function scanSkills(context?: AgentRuntimeContext): Promise<SkillHeader[]> {
  const nested = await Promise.all(SKILL_DIRS.map(dir => scanSkillDir(dir, context)))
  const deduped = new Map<string, SkillHeader>()

  for (const skill of nested.flat()) {
    if (!deduped.has(skill.name)) deduped.set(skill.name, skill)
  }

  return [...deduped.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SKILLS)
}

async function scanSkillDir(
  relativeDir: (typeof SKILL_DIRS)[number],
  context?: AgentRuntimeContext,
): Promise<SkillHeader[]> {
  const root = context?.projectRoot ?? getProjectRoot()
  const absoluteDir = join(root, relativeDir)

  let entries
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true })
  } catch {
    return []
  }

  const results = await Promise.allSettled(
    entries.map(async entry => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return null
      const skillName = normalizeSkillName(entry.name)
      if (!skillName) return null

      const baseDir = join(relativeDir, entry.name)
      const skillPath = join(baseDir, SKILL_FILE_NAME)
      const absoluteSkillPath = join(root, skillPath)

      let content: string
      try {
        content = await readFile(absoluteSkillPath, 'utf8')
      } catch {
        return null
      }

      const fileStat = await stat(absoluteSkillPath)
      const frontmatter = parseFrontmatter(
        content.split(/\r?\n/).slice(0, FRONTMATTER_MAX_LINES).join('\n'),
      )
      const markdownContent = stripFrontmatter(content)
      const description = frontmatter.description || extractMarkdownDescription(markdownContent, skillName)

      return {
        name: skillName,
        path: toSlashPath(skillPath),
        baseDir: toSlashPath(baseDir),
        source: relativeDir.startsWith('.jesse') ? '.jesse' : '.claude',
        description,
        whenToUse: frontmatter.when_to_use ?? null,
        mtimeMs: fileStat.mtimeMs,
      } satisfies SkillHeader
    }),
  )

  return results
    .filter((result): result is PromiseFulfilledResult<SkillHeader | null> => result.status === 'fulfilled')
    .map(result => result.value)
    .filter((skill): skill is SkillHeader => skill !== null)
}

function formatSkillManifest(skills: SkillHeader[]): string {
  if (skills.length === 0) return '(no skills found)'

  return skills.map(skill => {
    const whenToUse = skill.whenToUse ? ` When to use: ${skill.whenToUse}` : ''
    return `- ${skill.name}: ${truncate(skill.description, MAX_LISTING_DESC_CHARS)}${whenToUse} (${skill.path})`
  }).join('\n')
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content)
  if (!match) return {}

  const body = match[1]
  if (!body) return {}

  const values: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!field) continue

    const key = field[1]
    const value = field[2]
    if (!key || value === undefined) continue
    values[key] = stripQuotes(value.trim())
  }
  return values
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '')
}

function extractMarkdownDescription(content: string, skillName: string): string {
  const firstUsefulLine = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#'))

  return firstUsefulLine ?? `Skill instructions for ${skillName}`
}

function normalizeSkillName(name: string): string {
  const trimmed = name.trim().replace(/^\//, '')
  if (!trimmed) return ''
  if (basename(trimmed) !== trimmed) return ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)) return ''
  return trimmed
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 1)}…`
}

function toSlashPath(path: string): string {
  return path.replaceAll('\\', '/')
}
