/**
 * readState.ts - read-before-write guard for file editing tools
 *
 * Claude Code keeps a readFileState map and refuses to edit existing files that
 * were not read first or changed after being read. This is our simplified
 * version of that same safety boundary.
 */

import { readFile, stat } from 'node:fs/promises'
import { resolveToolPath } from '../workingDirectory.js'

export interface ReadFileRecord {
  path: string
  content: string
  mtimeMs: number
}

const readFiles = new Map<string, ReadFileRecord>()

export function normalizeToolPath(path: string): string {
  return resolveToolPath(path)
}

export async function rememberReadFile(path: string, content: string): Promise<void> {
  const normalizedPath = normalizeToolPath(path)
  const fileStat = await stat(normalizedPath)
  readFiles.set(normalizedPath, {
    path: normalizedPath,
    content,
    mtimeMs: fileStat.mtimeMs,
  })
}

export async function requireFreshRead(path: string): Promise<ReadFileRecord | string> {
  const normalizedPath = normalizeToolPath(path)
  const record = readFiles.get(normalizedPath)
  if (!record) {
    return `文件 ${path} 还没有被 read_file 读取过。请先读取文件内容，再写入或编辑。`
  }

  let currentContent: string
  try {
    currentContent = await readFile(normalizedPath, 'utf8')
  } catch (err) {
    return `读取当前文件状态失败：${String(err)}`
  }

  if (currentContent !== record.content) {
    return `文件 ${path} 在上次读取后已经发生变化。请重新 read_file 后再编辑，避免覆盖别人的改动。`
  }

  return record
}

export async function refreshReadFile(path: string, content: string): Promise<void> {
  await rememberReadFile(path, content)
}
