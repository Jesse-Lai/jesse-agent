/**
 * evals/runner.ts - deterministic evaluation harness for Jesse-Agent.
 *
 * This is not a user-facing tool. It is a developer-side regression suite that
 * drives the real agent loop with a scripted LLM, then checks tool behavior and
 * filesystem outcomes. The shape is intentionally close to Claude Code's
 * fixture/VCR mindset: keep the loop deterministic first, then add real-model
 * evals later.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runAgent, type AgentEvent } from '../loop.js'
import type { LLMStreamer, Message, ToolCall } from '../llm.js'
import type { Tool } from '../types.js'
import { setPermissionMode } from '../permissionMode.js'
import { rememberSessionAllowRule } from '../permissions.js'
import { getOriginalProjectRoot, setProjectRoot } from '../workingDirectory.js'
import { editFileTool } from '../tools/editFile.js'
import { readFileTool } from '../tools/readFile.js'
import { runCommandTool } from '../tools/runCommand.js'
import { createAgentWorktree, finishAgentWorktree } from '../worktrees.js'

const EVAL_TOOLS: Tool[] = [readFileTool, editFileTool, runCommandTool]
const execFileAsync = promisify(execFile)

interface EvalCheck {
  name: string
  passed: boolean
  details?: string
}

interface EvalResult {
  name: string
  passed: boolean
  checks: EvalCheck[]
  tempDir?: string
  error?: string
}

type ScriptedStep =
  | { type: 'tool_calls'; calls: Array<{ name: string; args: Record<string, unknown> }> }
  | { type: 'text'; text: string }

export async function runEvalSuite(): Promise<EvalResult[]> {
  const cases: Array<() => Promise<EvalResult>> = [
    runValidationEval,
    runReadBeforeWriteEval,
    runReadEditVerifyEval,
    runAgentWorktreeIsolationEval,
  ]

  const results: EvalResult[] = []
  for (const runCase of cases) {
    results.push(await runCase())
  }

  return results
}

async function runValidationEval(): Promise<EvalResult> {
  return runCase('tool-argument-validation', async checks => {
    const script: ScriptedStep[] = [
      { type: 'tool_calls', calls: [{ name: 'read_file', args: {} }] },
      { type: 'text', text: 'Validation rejected the malformed tool call.\nVERDICT: PASS' },
    ]

    const { events, unusedSteps } = await runScriptedAgent(script, [
      { role: 'user', content: 'Read a file, but the model will omit required args.' },
    ])

    const result = toolResult(events, 'read_file')
    check(checks, 'read_file was attempted', toolStarts(events).includes('read_file'))
    check(checks, 'missing required arg was rejected', result?.ok === false && result.content.includes('参数校验失败'), result?.content)
    check(checks, 'script reached final answer', finalText(events).includes('VERDICT: PASS'))
    check(checks, 'script consumed every fake model step', unusedSteps === 0, `${unusedSteps} unused step(s)`)
  })
}

async function runReadBeforeWriteEval(): Promise<EvalResult> {
  const root = await createMathProject('read-before-write')

  return runCase('read-before-write-guard', async checks => {
    await setProjectRoot(root)
    setPermissionMode('acceptEdits')

    const mathPath = join(root, 'src/math.js')
    const script: ScriptedStep[] = [
      {
        type: 'tool_calls',
        calls: [
          {
            name: 'edit_file',
            args: {
              path: mathPath,
              old_string: 'return a - b',
              new_string: 'return a + b',
            },
          },
        ],
      },
      { type: 'text', text: 'The edit was correctly rejected because the file was not read first.\nVERDICT: PASS' },
    ]

    const { events, unusedSteps } = await runScriptedAgent(script, [
      { role: 'user', content: 'Try editing without reading first.' },
    ])
    const result = toolResult(events, 'edit_file')
    const content = await readFile(mathPath, 'utf8')

    check(checks, 'edit_file was attempted', toolStarts(events).join(',') === 'edit_file')
    check(checks, 'edit was blocked by read-before-write guard', Boolean(result?.content.includes('编辑被拒绝') && result.content.includes('还没有被 read_file')), result?.content)
    check(checks, 'file stayed unchanged', content.includes('return a - b') && !content.includes('return a + b'))
    check(checks, 'script reached final answer', finalText(events).includes('VERDICT: PASS'))
    check(checks, 'script consumed every fake model step', unusedSteps === 0, `${unusedSteps} unused step(s)`)
  }, root)
}

async function runReadEditVerifyEval(): Promise<EvalResult> {
  const root = await createMathProject('read-edit-verify')

  return runCase('read-edit-verify-loop', async checks => {
    await setProjectRoot(root)
    setPermissionMode('acceptEdits')
    rememberSessionAllowRule('run_command', { command: 'npm run test', cwd: '.' })

    const mathPath = join(root, 'src/math.js')
    const script: ScriptedStep[] = [
      { type: 'tool_calls', calls: [{ name: 'read_file', args: { path: mathPath } }] },
      {
        type: 'tool_calls',
        calls: [
          {
            name: 'edit_file',
            args: {
              path: mathPath,
              old_string: 'return a - b',
              new_string: 'return a + b',
            },
          },
        ],
      },
      { type: 'tool_calls', calls: [{ name: 'run_command', args: { command: 'npm run test', cwd: '.' } }] },
      { type: 'text', text: 'Fixed add(a, b) and verified with npm run test.\nVERDICT: PASS' },
    ]

    const { events, unusedSteps } = await runScriptedAgent(script, [
      { role: 'user', content: 'Fix the broken add function and verify it.' },
    ])
    const content = await readFile(mathPath, 'utf8')
    const runResult = toolResult(events, 'run_command')

    check(checks, 'tool order was read -> edit -> verify', toolStarts(events).join(' -> ') === 'read_file -> edit_file -> run_command')
    check(checks, 'file was edited correctly', content.includes('return a + b'))
    check(checks, 'verification command ran and passed', Boolean(runResult?.content.includes('math ok')), runResult?.content)
    check(checks, 'final answer reports verification', finalText(events).includes('npm run test') && finalText(events).includes('VERDICT: PASS'))
    check(checks, 'script consumed every fake model step', unusedSteps === 0, `${unusedSteps} unused step(s)`)
  }, root)
}

async function runAgentWorktreeIsolationEval(): Promise<EvalResult> {
  const root = await createGitProject('agent-worktree-isolation')

  return runCase('agent-worktree-isolation-cleanup', async checks => {
    await setProjectRoot(root)

    const session = await createAgentWorktree({ agentId: 'eval-agent-worktree' })
    const result = await finishAgentWorktree(session)
    const existsAfterCleanup = await pathExists(session.worktreePath)

    check(checks, 'worktree was created under project', session.worktreePath.startsWith(root), session.worktreePath)
    check(checks, 'unchanged worktree was removed', result.status === 'removed', result.message)
    check(checks, 'cleanup reported no changes', result.changedFiles === 0 && result.commits === 0, result.message)
    check(checks, 'worktree directory no longer exists', !existsAfterCleanup, session.worktreePath)
  }, root)
}

async function runCase(
  name: string,
  run: (checks: EvalCheck[]) => Promise<void>,
  tempDir?: string,
): Promise<EvalResult> {
  const checks: EvalCheck[] = []
  try {
    await run(runFinally(checks))
  } catch (err) {
    checks.push({
      name: 'case did not throw',
      passed: false,
      details: err instanceof Error ? err.stack ?? err.message : String(err),
    })
  } finally {
    await setProjectRoot(getOriginalProjectRoot())
    setPermissionMode('default')
  }

  const passed = checks.every(item => item.passed)
  const keepTemp = process.env.JESSE_EVAL_KEEP_TEMP === '1'
  if (tempDir && passed && !keepTemp) {
    await rm(tempDir, { recursive: true, force: true })
  }

  return {
    name,
    passed,
    checks,
    tempDir: tempDir && (!passed || keepTemp) ? tempDir : undefined,
  }
}

function runFinally(checks: EvalCheck[]): EvalCheck[] {
  return checks
}

async function runScriptedAgent(
  script: ScriptedStep[],
  messages: Message[],
): Promise<{ events: AgentEvent[]; unusedSteps: number }> {
  const steps = [...script]
  const events: AgentEvent[] = []

  for await (const event of runAgent(messages, {
    tools: EVAL_TOOLS,
    maxTurns: script.length + 1,
    llmStream: createScriptedLLM(steps),
  })) {
    events.push(event)
  }

  return { events, unusedSteps: steps.length }
}

function createScriptedLLM(steps: ScriptedStep[]): LLMStreamer {
  let turn = 0
  return async function* scriptedLLM() {
    const step = steps.shift()
    if (!step) throw new Error(`Scripted LLM has no response for turn ${turn + 1}`)

    turn += 1
    if (step.type === 'text') {
      if (step.text) yield { type: 'text_delta', text: step.text }
      yield { type: 'done', response: { type: 'text', text: step.text, raw: { role: 'assistant', content: step.text } } }
      return
    }

    const toolCalls = step.calls.map((call, index): ToolCall => ({
      id: `eval_call_${turn}_${index + 1}`,
      type: 'function',
      function: {
        name: call.name,
        arguments: JSON.stringify(call.args),
      },
    }))

    yield {
      type: 'done',
      response: {
        type: 'tool_calls',
        toolCalls,
        raw: { role: 'assistant', content: null, tool_calls: toolCalls },
      },
    }
  }
}

async function createMathProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `jesse-eval-${prefix}-`))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'src/math.js'),
    [
      'export function add(a, b) {',
      '  return a - b',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(root, 'test.mjs'),
    [
      "import { add } from './src/math.js'",
      '',
      'const actual = add(2, 3)',
      'if (actual !== 5) {',
      "  console.error(`expected add(2, 3) to equal 5, got ${actual}`)",
      '  process.exit(1)',
      '}',
      "console.log('math ok')",
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node test.mjs' } }, null, 2),
    'utf8',
  )
  return await realpath(root)
}

async function createGitProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `jesse-eval-${prefix}-`))
  await writeFile(join(root, 'README.md'), '# eval repo\n', 'utf8')
  await git(['init'], root)
  await git(['config', 'user.email', 'eval@example.test'], root)
  await git(['config', 'user.name', 'Jesse Eval'], root)
  await git(['add', 'README.md'], root)
  await git(['commit', '-m', 'initial commit'], root)
  return await realpath(root)
}

async function git(args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync('git', args, { cwd })
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(err)}`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function check(checks: EvalCheck[], name: string, passed: boolean, details?: string): void {
  checks.push({ name, passed, details })
}

function toolStarts(events: AgentEvent[]): string[] {
  return events.flatMap(event => event.type === 'tool_start' ? [event.name] : [])
}

function toolResult(events: AgentEvent[], name: string): Extract<AgentEvent, { type: 'tool_result' }> | undefined {
  return events.find((event): event is Extract<AgentEvent, { type: 'tool_result' }> => (
    event.type === 'tool_result' && event.name === name
  ))
}

function finalText(events: AgentEvent[]): string {
  return events
    .flatMap(event => event.type === 'assistant_text' ? [event.text] : [])
    .join('\n')
}

function printResults(results: EvalResult[]): void {
  const passed = results.filter(result => result.passed).length
  console.log(`Jesse evals: ${passed}/${results.length} passed`)

  for (const result of results) {
    console.log(`\n${result.passed ? 'PASS' : 'FAIL'} ${result.name}`)
    for (const item of result.checks) {
      console.log(`  ${item.passed ? 'PASS' : 'FAIL'} ${item.name}`)
      if (!item.passed && item.details) console.log(indent(item.details, '    '))
    }
    if (result.tempDir) console.log(`  temp dir kept for debugging: ${result.tempDir}`)
  }
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map(line => `${prefix}${line}`).join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runEvalSuite()
  printResults(results)
  if (results.some(result => !result.passed)) process.exitCode = 1
}
