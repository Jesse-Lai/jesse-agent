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
import { getOriginalProjectRoot, getProjectRoot, setProjectRoot } from '../workingDirectory.js'
import { editFileTool } from '../tools/editFile.js'
import { readFileTool } from '../tools/readFile.js'
import { runCommandTool } from '../tools/runCommand.js'
import { writeFileTool } from '../tools/writeFile.js'
import { taskContinueTool } from '../tools/taskContinue.js'
import { restoreBackgroundAgentTask } from '../tools/agent.js'
import { createAgentWorktree, finishAgentWorktree } from '../worktrees.js'
import { continueAgentTask, readTaskOutput, startAgentTask } from '../tasks.js'
import { createAgentRuntimeContext } from '../runtimeContext.js'

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
    runBackgroundAgentTaskEval,
    runPerAgentRuntimeContextEval,
    runBackgroundAgentWorktreeContextEval,
    runBackgroundAgentContinuationEval,
    runBackgroundAgentCrossProcessResumeEval,
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

async function runBackgroundAgentTaskEval(): Promise<EvalResult> {
  return runCase('background-agent-task-registry', async checks => {
    const started = await startAgentTask({
      description: 'eval background agent',
      run: async context => {
        context.write('agent progress: started\n')
        await sleep(20)
        context.write('agent final: done\n')
      },
    })

    const result = await readTaskOutput(started.id, { block: true, timeoutMs: 1_000 })

    check(checks, 'task started as agent kind', started.kind === 'agent', started.kind)
    check(checks, 'task returned an agent id', started.id.startsWith('agent-'), started.id)
    check(checks, 'task completed successfully', result.snapshot.status === 'completed', result.snapshot.status)
    check(checks, 'task output includes progress', result.output.includes('agent progress: started'), result.output)
    check(checks, 'task output includes final report text', result.output.includes('agent final: done'), result.output)
  })
}

async function runPerAgentRuntimeContextEval(): Promise<EvalResult> {
  const root = await mkdtemp(join(tmpdir(), 'jesse-eval-agent-context-'))
  const parentRoot = join(root, 'parent')
  const childRoot = join(root, 'child')
  await mkdir(parentRoot, { recursive: true })
  await mkdir(childRoot, { recursive: true })
  await writeFile(join(parentRoot, 'marker.txt'), 'parent root\n', 'utf8')
  await writeFile(join(childRoot, 'marker.txt'), 'child context root\n', 'utf8')
  const realParentRoot = await realpath(parentRoot)
  const realChildRoot = await realpath(childRoot)

  return runCase('per-agent-runtime-context', async checks => {
    await setProjectRoot(realParentRoot)
    const context = createAgentRuntimeContext({
      agentId: 'eval-child-context',
      projectRoot: realChildRoot,
      cwd: realChildRoot,
      originalProjectRoot: realParentRoot,
    })
    const script: ScriptedStep[] = [
      { type: 'tool_calls', calls: [{ name: 'read_file', args: { path: 'marker.txt' } }] },
      { type: 'text', text: 'Read marker from isolated agent context.\nVERDICT: PASS' },
    ]

    const steps = [...script]
    const events: AgentEvent[] = []
    for await (const event of runAgent([
      { role: 'user', content: 'Read marker.txt from your context root.' },
    ], {
      tools: [readFileTool],
      maxTurns: script.length + 1,
      llmStream: createScriptedLLM(steps),
      context,
    })) {
      events.push(event)
    }

    const result = toolResult(events, 'read_file')
    check(checks, 'read_file used child context root', Boolean(result?.content.includes('child context root')), result?.content)
    check(checks, 'read_file did not read parent root', !Boolean(result?.content.includes('parent root')), result?.content)
    check(checks, 'global project root stayed on parent', getProjectRoot() === realParentRoot, getProjectRoot())
    check(checks, 'script consumed every fake model step', steps.length === 0, `${steps.length} unused step(s)`)
  }, root)
}

async function runBackgroundAgentWorktreeContextEval(): Promise<EvalResult> {
  const root = await createGitProject('background-agent-worktree')

  return runCase('background-agent-worktree-context', async checks => {
    await setProjectRoot(root)
    const session = await createAgentWorktree({
      agentId: 'eval-background-worktree',
      baseProjectRoot: root,
    })
    const context = createAgentRuntimeContext({
      agentId: 'eval-background-worktree',
      projectRoot: session.worktreePath,
      cwd: session.worktreePath,
      originalProjectRoot: root,
      worktreeSession: session,
    })

    const started = await startAgentTask({
      description: 'eval background worktree agent',
      run: async task => {
        task.write(`worktree path: ${session.worktreePath}\n`)
        const writeResult = await writeFileTool.execute({
          path: 'agent-output.txt',
          content: 'background worktree change\n',
        }, context)
        task.write(`${writeResult}\n`)
        const cleanup = await finishAgentWorktree(session)
        task.write(`Worktree status: ${cleanup.status}\n`)
        task.write(`Worktree changes: ${cleanup.changedFiles} file(s), ${cleanup.commits} commit(s)\n`)
      },
    })

    const result = await readTaskOutput(started.id, { block: true, timeoutMs: 1_000 })

    check(checks, 'task started as agent kind', started.kind === 'agent', started.kind)
    check(checks, 'background worktree task completed', result.snapshot.status === 'completed', result.snapshot.status)
    check(checks, 'worktree was kept because it changed files', result.output.includes('Worktree status: kept'), result.output)
    check(checks, 'worktree change count was reported', result.output.includes('Worktree changes: 1 file(s)'), result.output)
    check(checks, 'global project root stayed on parent repo', getProjectRoot() === root, getProjectRoot())
  }, root)
}

async function runBackgroundAgentContinuationEval(): Promise<EvalResult> {
  return runCase('background-agent-continuation', async checks => {
    const started = await startAgentTask({
      description: 'eval continuation agent',
      run: async context => {
        context.write('initial answer\n')
      },
      continueRun: async context => {
        context.write(`continued answer: ${context.prompt}\n`)
      },
    })

    const initial = await readTaskOutput(started.id, { block: true, timeoutMs: 1_000 })
    const continuedText = await taskContinueTool.execute({
      task_id: started.id,
      prompt: 'follow up question',
    })
    const continued = await readTaskOutput(started.id, { block: true, timeoutMs: 1_000 })

    check(checks, 'initial task completed', initial.snapshot.status === 'completed', initial.snapshot.status)
    check(checks, 'task reports continuation available', initial.snapshot.continuationAvailable === true, String(initial.snapshot.continuationAvailable))
    check(checks, 'task_continue restarted same task', continuedText.includes(started.id), continuedText)
    check(checks, 'continued task completed', continued.snapshot.status === 'completed', continued.snapshot.status)
    check(checks, 'continued output includes follow-up', continued.output.includes('continued answer: follow up question'), continued.output)
  })
}

async function runBackgroundAgentCrossProcessResumeEval(): Promise<EvalResult> {
  const root = await mkdtemp(join(tmpdir(), 'jesse-eval-agent-cross-process-'))
  const realRoot = await realpath(root)

  return runCase('background-agent-cross-process-resume', async checks => {
    await setProjectRoot(realRoot)
    const taskId = `agent-20260101T000000Z-cross${Date.now().toString(36)}`
    const outputDir = join('.jesse', 'task-output')
    const transcriptPath = join(outputDir, `${taskId}.messages.jsonl`)
    const metadataPath = join(outputDir, `${taskId}.agent.json`)
    const context = createAgentRuntimeContext({
      agentId: 'eval-restored-agent',
      projectRoot: realRoot,
      cwd: realRoot,
      originalProjectRoot: realRoot,
    })
    const messages: Message[] = [
      { role: 'system', content: 'You are a Jesse-Agent sub-agent of type "general".' },
      { role: 'user', content: 'Task description: restored eval agent\n\nInitial task.' },
      { role: 'assistant', content: 'Initial answer before CLI restart.' },
    ]

    await mkdir(outputDir, { recursive: true })
    await writeFile(transcriptPath, `${messages.map(message => JSON.stringify(message)).join('\n')}\n`, 'utf8')
    await writeFile(metadataPath, `${JSON.stringify({
      version: 1,
      taskId,
      agentType: 'general',
      description: 'restored eval agent',
      maxTurns: 2,
      isolation: null,
      runtimeContext: context,
      worktreeSession: null,
      worktreeResult: null,
      worktreeCleanupError: null,
      subAgentToolNames: [],
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8')

    const steps: ScriptedStep[] = [
      { type: 'text', text: 'Restored continuation answered. VERDICT: PASS' },
    ]
    const restored = await restoreBackgroundAgentTask(taskId, { llmStream: createScriptedLLM(steps) })
    const continued = await continueAgentTask(taskId, 'follow up after restart')
    const output = await readTaskOutput(taskId, { block: true, timeoutMs: 1_000 })
    const transcript = await readFile(transcriptPath, 'utf8')

    check(checks, 'task restored from disk without prior registry entry', restored.id === taskId && restored.status === 'completed', `${restored.id} ${restored.status}`)
    check(checks, 'restored task reports continuation available', restored.continuationAvailable === true, String(restored.continuationAvailable))
    check(checks, 'continuation restarted restored task', continued.status === 'running', continued.status)
    check(checks, 'continued restored task completed', output.snapshot.status === 'completed', output.snapshot.status)
    check(checks, 'continued output includes restored answer', output.output.includes('Restored continuation answered'), output.output)
    check(checks, 'transcript persisted follow-up prompt', transcript.includes('follow up after restart'), transcript)
    check(checks, 'scripted continuation was consumed', steps.length === 0, `${steps.length} unused step(s)`)
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runEvalSuite()
  printResults(results)
  if (results.some(result => !result.passed)) process.exitCode = 1
}
