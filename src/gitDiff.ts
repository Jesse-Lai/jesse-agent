import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getProjectRoot } from './workingDirectory.js'

const execFileAsync = promisify(execFile)
const DIFF_MAX_CHARS = 24_000

export async function formatGitDiff(): Promise<string> {
  const cwd = getProjectRoot()

  const status = await git(['status', '--short'], cwd)
  if (!status.ok) return `读取 git status 失败：${status.output}`

  const statusText = status.output.trimEnd()
  if (!statusText) return '当前工作区没有 git 改动。'

  const unstagedStat = await git(['diff', '--stat'], cwd)
  const stagedStat = await git(['diff', '--cached', '--stat'], cwd)
  const unstagedDiff = await git(['diff', '--'], cwd)
  const stagedDiff = await git(['diff', '--cached', '--'], cwd)

  const sections = [
    'Git changes',
    '',
    '--- status ---',
    statusText,
  ]

  if (stagedStat.output.trim()) {
    sections.push('', '--- staged stat ---', stagedStat.output.trimEnd())
  }
  if (unstagedStat.output.trim()) {
    sections.push('', '--- unstaged stat ---', unstagedStat.output.trimEnd())
  }
  if (stagedDiff.output.trim()) {
    sections.push('', '--- staged diff ---', stagedDiff.output.trimEnd())
  }
  if (unstagedDiff.output.trim()) {
    sections.push('', '--- unstaged diff ---', unstagedDiff.output.trimEnd())
  }

  const body = sections.join('\n')
  if (body.length <= DIFF_MAX_CHARS) return body

  return [
    body.slice(0, DIFF_MAX_CHARS),
    '',
    `... diff output truncated at ${DIFF_MAX_CHARS.toLocaleString()} chars. Run git diff directly for the full output.`,
  ].join('\n')
}

async function git(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n') }
  } catch (err) {
    const error = err as ExecFileError
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n')
    return { ok: false, output }
  }
}

interface ExecFileError extends Error {
  stdout?: string
  stderr?: string
}
