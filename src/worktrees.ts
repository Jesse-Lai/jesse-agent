/**
 * worktrees.ts - controlled git worktree isolation for the current session.
 *
 * This mirrors Claude Code's EnterWorktree/ExitWorktree shape, but keeps the
 * first version small: git worktrees only, no hooks/tmux/sparse checkout yet.
 */

import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { getOriginalProjectRoot, getProjectRoot, setProjectRoot } from './workingDirectory.js'

const WORKTREE_DIR = '.jesse/worktrees'
const VALID_WORKTREE_NAME = /^[A-Za-z0-9._-]+$/
const MAX_WORKTREE_NAME_LENGTH = 64

export interface WorktreeSession {
  sessionId: string
  originalCwd: string
  gitRoot: string
  worktreeName: string
  worktreePath: string
  worktreeBranch: string
  originalBranch?: string
  originalHeadCommit: string
  createdAt: string
}

export interface WorktreeEventInput {
  action: 'entered' | 'kept' | 'removed'
  session: WorktreeSession | null
  message: string
}

export interface ExitWorktreeInput {
  action: 'keep' | 'remove'
  discardChanges?: boolean
}

export interface ExitWorktreeResult {
  exited: boolean
  action: 'keep' | 'remove' | 'noop'
  message: string
  session: WorktreeSession | null
  changedFiles?: number
  commits?: number
}

let activeSessionId: string | null = null
let appendWorktreeEvent: ((event: WorktreeEventInput) => Promise<void> | void) | null = null
let currentWorktreeSession: WorktreeSession | null = null

export function initializeWorktreeRuntime(
  sessionId: string,
  eventSink: (event: WorktreeEventInput) => Promise<void> | void,
): void {
  activeSessionId = sessionId
  appendWorktreeEvent = eventSink
}

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

export async function restoreWorktreeSession(session: WorktreeSession | null): Promise<void> {
  currentWorktreeSession = null
  await setProjectRoot(getOriginalProjectRoot())

  if (!session) return

  const info = await stat(session.worktreePath)
  if (!info.isDirectory()) throw new Error(`worktree 路径不是目录：${session.worktreePath}`)

  process.chdir(session.worktreePath)
  await setProjectRoot(session.worktreePath)
  currentWorktreeSession = session
}

export async function enterWorktree(input: { name?: unknown } = {}): Promise<WorktreeSession> {
  if (!activeSessionId) throw new Error('worktree runtime 尚未初始化')
  if (currentWorktreeSession) {
    throw new Error(`当前 session 已经在 worktree 中：${currentWorktreeSession.worktreePath}`)
  }

  const name = normalizeWorktreeName(input.name, activeSessionId)
  validateWorktreeName(name)

  const originalCwd = getProjectRoot()
  const gitRoot = await findGitRoot(originalCwd)
  const originalHeadCommit = (await gitOrThrow(['rev-parse', 'HEAD'], gitRoot)).trim()
  const originalBranch = (await git(['branch', '--show-current'], gitRoot)).stdout.trim() || undefined
  const worktreePath = join(gitRoot, WORKTREE_DIR, name)
  const worktreeBranch = `jesse-worktree-${name}`

  await mkdir(join(gitRoot, WORKTREE_DIR), { recursive: true })
  await gitOrThrow(['worktree', 'add', '-b', worktreeBranch, worktreePath, 'HEAD'], gitRoot)

  const session: WorktreeSession = {
    sessionId: activeSessionId,
    originalCwd,
    gitRoot,
    worktreeName: name,
    worktreePath,
    worktreeBranch,
    originalBranch,
    originalHeadCommit,
    createdAt: new Date().toISOString(),
  }

  process.chdir(worktreePath)
  await setProjectRoot(worktreePath)
  currentWorktreeSession = session

  await emitWorktreeEvent({
    action: 'entered',
    session,
    message: `Entered worktree ${worktreePath} on branch ${worktreeBranch}.`,
  })

  return session
}

export async function exitWorktree(input: ExitWorktreeInput): Promise<ExitWorktreeResult> {
  const session = currentWorktreeSession
  if (!session) {
    return {
      exited: false,
      action: 'noop',
      session: null,
      message: 'No active worktree session. Nothing changed.',
    }
  }

  if (input.action !== 'keep' && input.action !== 'remove') {
    throw new Error('action 必须是 keep 或 remove')
  }

  if (input.action === 'keep') {
    await restoreOriginalCwd(session)
    currentWorktreeSession = null
    const message = `Exited worktree. Work is kept at ${session.worktreePath} on branch ${session.worktreeBranch}.`
    await emitWorktreeEvent({ action: 'kept', session: null, message })
    return { exited: true, action: 'keep', session, message }
  }

  const changeSummary = await countWorktreeChanges(session)
  if (!input.discardChanges && (changeSummary.changedFiles > 0 || changeSummary.commits > 0)) {
    return {
      exited: false,
      action: 'remove',
      session,
      changedFiles: changeSummary.changedFiles,
      commits: changeSummary.commits,
      message: [
        `Refusing to remove worktree ${session.worktreePath} because it has ${changeSummary.changedFiles} changed file(s) and ${changeSummary.commits} commit(s).`,
        'Ask the user to confirm discarding this work, then call exit_worktree with discard_changes=true, or use action="keep".',
      ].join('\n'),
    }
  }

  await restoreOriginalCwd(session)
  await gitOrThrow(['worktree', 'remove', '--force', session.worktreePath], session.gitRoot)
  const deleteBranch = await git(['branch', '-D', session.worktreeBranch], session.gitRoot)
  currentWorktreeSession = null

  const branchWarning = deleteBranch.code === 0 ? '' : ` Branch cleanup failed: ${deleteBranch.stderr.trim()}`
  const message = `Exited and removed worktree ${session.worktreePath}.${branchWarning}`
  await emitWorktreeEvent({ action: 'removed', session: null, message })
  return {
    exited: true,
    action: 'remove',
    session,
    changedFiles: changeSummary.changedFiles,
    commits: changeSummary.commits,
    message,
  }
}

export function formatWorktreePromptContext(): string {
  const session = currentWorktreeSession
  if (!session) return '当前没有 active worktree session。'
  return [
    `当前 active worktree：${session.worktreePath}`,
    `worktree branch：${session.worktreeBranch}`,
    `原始目录：${session.originalCwd}`,
  ].join('\n')
}

async function restoreOriginalCwd(session: WorktreeSession): Promise<void> {
  process.chdir(session.originalCwd)
  await setProjectRoot(session.originalCwd)
}

async function countWorktreeChanges(session: WorktreeSession): Promise<{ changedFiles: number; commits: number }> {
  const [status, commits] = await Promise.all([
    git(['status', '--porcelain'], session.worktreePath),
    git(['rev-list', '--count', `${session.originalHeadCommit}..HEAD`], session.worktreePath),
  ])

  if (status.code !== 0) throw new Error(`无法读取 worktree 状态：${status.stderr.trim()}`)
  if (commits.code !== 0) throw new Error(`无法读取 worktree commit 状态：${commits.stderr.trim()}`)

  return {
    changedFiles: status.stdout.split('\n').filter(line => line.trim()).length,
    commits: Number.parseInt(commits.stdout.trim(), 10) || 0,
  }
}

async function findGitRoot(cwd: string): Promise<string> {
  const result = await git(['rev-parse', '--show-toplevel'], cwd)
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`当前目录不是 git 仓库，无法创建 worktree：${cwd}`)
  }
  return result.stdout.trim()
}

async function gitOrThrow(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const errorCode = (error as NodeJS.ErrnoException | null)?.code
      const code = typeof errorCode === 'number'
        ? errorCode
        : error
          ? 1
          : 0
      resolve({ code, stdout, stderr })
    })
  })
}

function normalizeWorktreeName(input: unknown, sessionId: string): string {
  if (typeof input === 'string' && input.trim()) return input.trim()
  const shortSession = sessionId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 24)
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${shortSession}-${suffix}`
}

export function validateWorktreeName(name: string): void {
  if (name.length > MAX_WORKTREE_NAME_LENGTH) {
    throw new Error(`worktree name 最多 ${MAX_WORKTREE_NAME_LENGTH} 个字符`)
  }
  if (!VALID_WORKTREE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error('worktree name 只能包含字母、数字、点、下划线和短横线，且不能是 . 或 ..')
  }
  if (basename(name) !== name) {
    throw new Error('worktree name 不能包含路径分隔符')
  }
}

async function emitWorktreeEvent(event: WorktreeEventInput): Promise<void> {
  await appendWorktreeEvent?.(event)
}
