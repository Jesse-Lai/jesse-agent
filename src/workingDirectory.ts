/**
 * workingDirectory.ts —— 命令执行目录约束
 *
 * 解决什么问题：
 *   同一条 shell 命令站在不同目录执行，结果可能完全不同。这里把 agent 启动时
 *   的目录固定为 project root，并要求 run_command 的 cwd 必须留在这个目录内。
 *
 * 对应 Claude Code：
 *   Claude Code 有 original cwd / current cwd / allowed working directories。
 *   我们先做简化版：allowed working directory 只有 project root 这一棵目录树。
 */

import { realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const originalProjectRoot = realpathSync(process.cwd())
let activeProjectRoot = originalProjectRoot

export interface ResolvedWorkingDirectory {
  /** 传给 child_process.exec 的绝对真实路径。 */
  absolutePath: string
  /** 给人看的项目相对路径。 */
  displayPath: string
  /** 当前允许工具操作的项目根目录。普通模式是启动目录；worktree 模式是 worktree 根目录。 */
  projectRoot: string
}

export async function resolveWorkingDirectory(input: unknown): Promise<ResolvedWorkingDirectory> {
  const rawCwd = normalizeCwdInput(input)
  const projectRoot = getProjectRoot()
  const requestedPath = isAbsolute(rawCwd) ? rawCwd : resolve(projectRoot, rawCwd)

  let realRequestedPath: string
  try {
    realRequestedPath = await realpath(requestedPath)
  } catch {
    throw new Error(`cwd 不存在或不可访问：${rawCwd}`)
  }

  const info = await stat(realRequestedPath)
  if (!info.isDirectory()) {
    throw new Error(`cwd 不是目录：${rawCwd}`)
  }

  if (!isInsideProjectRoot(realRequestedPath)) {
    throw new Error(`cwd 必须位于项目目录内：${rawCwd}`)
  }

  return {
    absolutePath: realRequestedPath,
    displayPath: toProjectRelativePath(realRequestedPath),
    projectRoot,
  }
}

export function getProjectRoot(): string {
  return activeProjectRoot
}

export function getOriginalProjectRoot(): string {
  return originalProjectRoot
}

export async function setProjectRoot(path: string): Promise<void> {
  const realPath = await realpath(path)
  const info = await stat(realPath)
  if (!info.isDirectory()) throw new Error(`project root 不是目录：${path}`)
  activeProjectRoot = realPath
}

export function isPathWithinProjectRoot(input: unknown): boolean {
  if (typeof input !== 'string') return false
  const trimmed = input.trim()
  if (!trimmed || trimmed.includes('\0')) return false

  const projectRoot = getProjectRoot()
  const requestedPath = isAbsolute(trimmed) ? trimmed : resolve(projectRoot, trimmed)
  return isInsideProjectRoot(requestedPath)
}

export function resolveToolPath(path: string): string {
  return isAbsolute(path) ? path : resolve(getProjectRoot(), path)
}

function normalizeCwdInput(input: unknown): string {
  if (input === undefined || input === null) return '.'
  if (typeof input !== 'string') throw new Error('cwd 必须是字符串')

  const trimmed = input.trim()
  if (!trimmed) return '.'
  if (trimmed.includes('\0')) throw new Error('cwd 不能包含 NUL 字符')

  return trimmed
}

function isInsideProjectRoot(candidate: string): boolean {
  const projectRoot = getProjectRoot()
  const rel = relative(projectRoot, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function toProjectRelativePath(candidate: string): string {
  const projectRoot = getProjectRoot()
  const rel = relative(projectRoot, candidate)
  return rel === '' ? '.' : rel
}
