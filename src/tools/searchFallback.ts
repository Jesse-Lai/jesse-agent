/**
 * searchFallback.ts - dependency-free fallback for grep_code/glob_files.
 *
 * ripgrep is preferred when available. This fallback keeps the tools usable on
 * machines without rg, which is important for a local personal agent.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export const DEFAULT_SEARCH_IGNORED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.jesse/sessions',
  '.jesse/tool-results',
  '.jesse/task-output',
  '.jesse/worktrees',
] as const

const DEFAULT_IGNORED_DIRS = new Set<string>(DEFAULT_SEARCH_IGNORED_DIRS)

const MAX_FALLBACK_FILE_BYTES = 1_000_000
const MAX_FALLBACK_FILES = 20_000

export interface GrepFallbackMatch {
  path: string
  line: number
  text: string
}

export async function fallbackGlobFiles(input: {
  projectRoot: string
  searchRoot: string
  pattern: string
  maxResults: number
}): Promise<string[]> {
  const matcher = globToRegExp(normalizeGlob(input.pattern))
  const results: string[] = []
  let visited = 0

  await walkFiles(input.projectRoot, input.searchRoot, async file => {
    if (visited++ >= MAX_FALLBACK_FILES) return false
    const projectRel = toPosix(relative(input.projectRoot, file))
    const searchRel = toPosix(relative(input.searchRoot, file))
    const basename = projectRel.split('/').pop() ?? projectRel
    if (matcher.test(projectRel) || matcher.test(searchRel) || matcher.test(basename)) results.push(projectRel)
    return results.length < input.maxResults
  })

  return results
}

export async function fallbackGrepCode(input: {
  projectRoot: string
  searchRoot: string
  pattern: string
  glob?: string
  maxResults: number
  ignoreCase: boolean
}): Promise<GrepFallbackMatch[]> {
  const pattern = compilePattern(input.pattern, input.ignoreCase)
  const globMatcher = input.glob ? globToRegExp(normalizeGlob(input.glob)) : null
  const matches: GrepFallbackMatch[] = []
  let visited = 0

  await walkFiles(input.projectRoot, input.searchRoot, async file => {
    if (visited++ >= MAX_FALLBACK_FILES) return false
    const rel = toPosix(relative(input.projectRoot, file))
    if (globMatcher && !globMatcher.test(rel) && !globMatcher.test(rel.split('/').pop() ?? rel)) return true

    const info = await stat(file)
    if (info.size > MAX_FALLBACK_FILE_BYTES) return true

    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch {
      return true
    }
    if (content.includes('\0')) return true

    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index++) {
      pattern.lastIndex = 0
      if (!pattern.test(lines[index] ?? '')) continue
      matches.push({ path: rel, line: index + 1, text: lines[index] ?? '' })
      if (matches.length >= input.maxResults) return false
    }
    return true
  })

  return matches
}

async function walkFiles(
  projectRoot: string,
  dir: string,
  visit: (file: string) => Promise<boolean>,
): Promise<boolean> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return true
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const rel = toPosix(relative(projectRoot, fullPath))
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(rel, entry.name)) continue
      const shouldContinue = await walkFiles(projectRoot, fullPath, visit)
      if (!shouldContinue) return false
      continue
    }
    if (!entry.isFile()) continue
    const shouldContinue = await visit(fullPath)
    if (!shouldContinue) return false
  }
  return true
}

function shouldSkipDirectory(relativePath: string, basename: string): boolean {
  if (DEFAULT_IGNORED_DIRS.has(basename) || DEFAULT_IGNORED_DIRS.has(relativePath)) return true
  return Array.from(DEFAULT_IGNORED_DIRS).some(dir => relativePath.startsWith(`${dir}/`))
}

export function defaultRgIgnoreArgs(searchPath: string): string[] {
  return DEFAULT_SEARCH_IGNORED_DIRS
    .filter(dir => !isExplicitlySearchingIgnoredPath(searchPath, dir))
    .flatMap(dir => ['--glob', `!${dir}/**`])
}

function isExplicitlySearchingIgnoredPath(searchPath: string, ignoredDir: string): boolean {
  const normalized = normalizeSearchPath(searchPath)
  return normalized === ignoredDir || normalized.startsWith(`${ignoredDir}/`)
}

function normalizeSearchPath(path: string): string {
  let normalized = toPosix(path.trim() || '.')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  while (normalized.endsWith('/') && normalized !== '/') normalized = normalized.slice(0, -1)
  return normalized || '.'
}

function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? 'gi' : 'g')
  } catch {
    return new RegExp(escapeRegExp(pattern), ignoreCase ? 'gi' : 'g')
  }
}

function globToRegExp(glob: string): RegExp {
  let source = '^'
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (!char) continue
    const next = glob[index + 1]

    if (char === '*') {
      if (next === '*') {
        const after = glob[index + 2]
        if (after === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '{') {
      const end = glob.indexOf('}', index + 1)
      if (end !== -1) {
        const alternatives = glob
          .slice(index + 1, end)
          .split(',')
          .map(escapeRegExp)
          .join('|')
        source += `(?:${alternatives})`
        index = end
        continue
      }
    }
    source += escapeRegExp(char)
  }
  source += '$'
  return new RegExp(source)
}

function normalizeGlob(pattern: string): string {
  return toPosix(pattern.trim() || '**/*')
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
