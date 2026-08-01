/**
 * ideBridge.ts - one-shot JSONL bridge for editor frontends.
 *
 * The CLI remains the human terminal UI. This bridge is the first stable seam
 * for VS Code and future desktop/IM clients: read a JSON request from stdin,
 * run the existing agent core, and stream machine-readable JSONL events back.
 */

import { stdin, stdout, stderr } from 'node:process'
import { runAgent } from './loop.js'
import { loadMcpRuntimeContext, type McpRuntimeContext } from './mcp.js'
import { setExternalTools } from './tools/index.js'
import { setProjectRoot } from './workingDirectory.js'
import { setPermissionMode } from './permissionMode.js'
import {
  buildFreshSystemPrompt,
  buildIdeMessages,
  normalizeMaxTurns,
  normalizeWorkspaceRoot,
  parseIdeRequest,
  type IdeBridgeOutput,
  type IdeBridgeRequest,
} from './ideProtocol.js'

console.log = (...args: unknown[]) => {
  stderr.write(`${args.map(String).join(' ')}\n`)
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    stdout.write([
      'Usage: npm run ide',
      '',
      'Reads an IdeBridgeRequest JSON object from stdin and writes JSONL events to stdout.',
      'Default permissionMode is plan so editor calls cannot block on terminal confirmations.',
      '',
    ].join('\n'))
    return
  }

  let mcpRuntime: McpRuntimeContext | null = null
  try {
    const request = parseRequest(await readStdin())
    const workspaceRoot = normalizeWorkspaceRoot(request.context?.workspaceRoot)
    if (workspaceRoot) {
      process.chdir(workspaceRoot)
      await setProjectRoot(workspaceRoot)
    }

    const permissionMode = request.permissionMode ?? 'plan'
    const modeResult = setPermissionMode(permissionMode)
    if (!modeResult.ok) throw new Error(modeResult.reason)

    mcpRuntime = await loadMcpRuntimeContext()
    setExternalTools(mcpRuntime.tools)

    writeJsonl({ type: 'ready', workspaceRoot, permissionMode })

    const messages = await buildIdeMessages(request, mcpRuntime)
    for await (const event of runAgent(messages, {
      maxTurns: normalizeMaxTurns(request.maxTurns),
      refreshSystemPrompt: async currentMessages => {
        const first = currentMessages[0]
        if (first?.role === 'system') first.content = await buildFreshSystemPrompt(mcpRuntime)
      },
    })) {
      writeJsonl({ type: 'agent_event', event })
    }

    writeJsonl({ type: 'done', messageCount: messages.length })
  } catch (err) {
    writeJsonl({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  } finally {
    await mcpRuntime?.close()
  }
}

function parseRequest(raw: string): IdeBridgeRequest {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('stdin JSON request is empty')
  return parseIdeRequest(JSON.parse(trimmed))
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function writeJsonl(output: IdeBridgeOutput): void {
  stdout.write(`${JSON.stringify(output)}\n`)
}

main().catch(err => {
  stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
