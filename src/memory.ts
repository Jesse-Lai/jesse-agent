/**
 * memory.ts - file-based project memory (Phase 7 / Step 19)
 *
 * Claude Code's auto-memory is file-first: MEMORY.md is a small index, while
 * each durable fact/preference lives in its own Markdown file with frontmatter.
 * This module implements the simplified version: scan the project memory
 * directory and expose a compact manifest for the system prompt.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { getProjectRoot } from './workingDirectory.js'

export const PROJECT_MEMORY_DIR = '.jesse/memory'
export const PROJECT_MEMORY_INDEX = '.jesse/memory/MEMORY.md'

const FRONTMATTER_MAX_LINES = 30
const MAX_MEMORY_FILES = 200
const MAX_INDEX_CHARS = 12_000

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface MemoryHeader {
  /** Path the agent can pass to read_file. */
  path: string
  /** Path relative to .jesse/memory, useful for MEMORY.md links. */
  memoryPath: string
  name: string | null
  description: string | null
  type: MemoryType | null
  mtimeMs: number
}

export interface ProjectMemoryContext {
  memoryDir: string
  indexPath: string
  indexContent: string
  memories: MemoryHeader[]
  manifest: string
  error?: string
}

export async function loadProjectMemoryContext(): Promise<ProjectMemoryContext> {
  try {
    await ensureProjectMemoryStore()
    const [indexContent, memories] = await Promise.all([
      readMemoryIndex(),
      scanMemoryHeaders(),
    ])

    return {
      memoryDir: PROJECT_MEMORY_DIR,
      indexPath: PROJECT_MEMORY_INDEX,
      indexContent,
      memories,
      manifest: formatMemoryManifest(memories),
    }
  } catch (err) {
    return {
      memoryDir: PROJECT_MEMORY_DIR,
      indexPath: PROJECT_MEMORY_INDEX,
      indexContent: '',
      memories: [],
      manifest: '(memory unavailable)',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function ensureProjectMemoryStore(): Promise<void> {
  const root = getProjectRoot()
  const dir = join(root, PROJECT_MEMORY_DIR)
  const index = join(root, PROJECT_MEMORY_INDEX)

  await mkdir(dir, { recursive: true })

  try {
    const indexStat = await stat(index)
    if (indexStat.isFile()) return
  } catch {
    // Missing index is expected on first run.
  }

  await writeFile(index, defaultMemoryIndex(), 'utf8')
}

async function readMemoryIndex(): Promise<string> {
  const raw = await readFile(join(getProjectRoot(), PROJECT_MEMORY_INDEX), 'utf8')
  if (raw.length <= MAX_INDEX_CHARS) return raw.trim()
  return `${raw.slice(0, MAX_INDEX_CHARS).trim()}\n\n> WARNING: MEMORY.md was truncated for prompt context. Keep it as a short index.`
}

async function scanMemoryHeaders(): Promise<MemoryHeader[]> {
  const root = getProjectRoot()
  const memoryRoot = join(root, PROJECT_MEMORY_DIR)
  const files = await walkMarkdownFiles(memoryRoot)

  const headers = await Promise.allSettled(
    files.map(filePath => readMemoryHeader(filePath, root, memoryRoot)),
  )

  return headers
    .filter((result): result is PromiseFulfilledResult<MemoryHeader> => result.status === 'fulfilled')
    .map(result => result.value)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES)
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkMarkdownFiles(fullPath))
      continue
    }

    if (!entry.isFile()) continue
    if (extname(entry.name) !== '.md') continue
    if (basename(entry.name) === 'MEMORY.md') continue
    files.push(fullPath)
  }

  return files
}

async function readMemoryHeader(filePath: string, root: string, memoryRoot: string): Promise<MemoryHeader> {
  const [content, fileStat] = await Promise.all([
    readFile(filePath, 'utf8'),
    stat(filePath),
  ])
  const firstLines = content.split(/\r?\n/).slice(0, FRONTMATTER_MAX_LINES).join('\n')
  const frontmatter = parseFrontmatter(firstLines)

  return {
    path: toSlashPath(relative(root, filePath)),
    memoryPath: toSlashPath(relative(memoryRoot, filePath)),
    name: frontmatter.name ?? null,
    description: frontmatter.description ?? null,
    type: parseMemoryType(frontmatter.type),
    mtimeMs: fileStat.mtimeMs,
  }
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

function parseMemoryType(raw: string | undefined): MemoryType | null {
  if (!raw) return null
  return MEMORY_TYPES.find(type => type === raw) ?? null
}

function formatMemoryManifest(memories: MemoryHeader[]): string {
  if (memories.length === 0) return '(no topic memory files yet)'

  return memories.map(memory => {
    const tag = memory.type ? `[${memory.type}] ` : ''
    const name = memory.name ? `${memory.name} — ` : ''
    const description = memory.description ?? 'no description'
    const updated = new Date(memory.mtimeMs).toISOString()
    return `- ${tag}${memory.path} (${updated}): ${name}${description}`
  }).join('\n')
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

function toSlashPath(path: string): string {
  return path.split(sep).join('/')
}

function defaultMemoryIndex(): string {
  return [
    '# Jesse Agent Memory',
    '',
    'This file is a short index for durable memories. Keep each entry to one line.',
    'Detailed memories live in separate Markdown files in this directory with frontmatter:',
    '',
    '```md',
    '---',
    'name: short name',
    'description: one-line relevance hint',
    'type: user | feedback | project | reference',
    '---',
    '',
    'Memory body.',
    '```',
    '',
    '## Index',
    '',
  ].join('\n')
}
