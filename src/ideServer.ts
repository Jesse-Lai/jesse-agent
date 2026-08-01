/**
 * ideServer.ts - long-lived local server for IDE frontends.
 *
 * The VS Code extension starts this once, then sends POST /ask requests instead
 * of spawning a fresh agent process for every prompt.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { stderr, stdout } from 'node:process'
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

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 0
const MAX_BODY_BYTES = 2 * 1024 * 1024

let mcpRuntime: McpRuntimeContext | null = null
let busy = false

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    stdout.write([
      'Usage: npm run ide:server',
      '',
      'Starts a local HTTP server for IDE clients.',
      'POST /ask with an IdeBridgeRequest JSON body returns JSONL events.',
      '',
    ].join('\n'))
    return
  }

  mcpRuntime = await loadMcpRuntimeContext()
  setExternalTools(mcpRuntime.tools)

  const server = createServer((req, res) => {
    void routeRequest(req, res)
  })
  server.on('error', err => {
    stderr.write(`ide server error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  })

  const port = normalizePort(process.env.JESSE_IDE_PORT)
  server.listen(port, DEFAULT_HOST, () => {
    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : port
    writeStartupJson({ type: 'server_ready', host: DEFAULT_HOST, port: actualPort })
  })

  const close = async () => {
    server.close()
    await mcpRuntime?.close()
  }
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      writeJson(res, 200, { ok: true, busy })
      return
    }

    if (req.method !== 'POST' || req.url !== '/ask') {
      writeJson(res, 404, { error: 'not found' })
      return
    }

    if (busy) {
      writeJson(res, 409, { error: 'Jesse Agent IDE server is busy. Wait for the current request to finish.' })
      return
    }

    busy = true
    try {
      const request = parseIdeRequest(JSON.parse(await readBody(req)))
      await runAsk(request, res)
    } finally {
      busy = false
    }
  } catch (err) {
    if (!res.headersSent) {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    } else {
      writeJsonl(res, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      res.end()
    }
  }
}

async function runAsk(request: IdeBridgeRequest, res: ServerResponse): Promise<void> {
  const workspaceRoot = normalizeWorkspaceRoot(request.context?.workspaceRoot)
  if (workspaceRoot) {
    process.chdir(workspaceRoot)
    await setProjectRoot(workspaceRoot)
  }

  const permissionMode = request.permissionMode ?? 'plan'
  const modeResult = setPermissionMode(permissionMode)
  if (!modeResult.ok) throw new Error(modeResult.reason)

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  writeJsonl(res, { type: 'ready', workspaceRoot, permissionMode })

  const messages = await buildIdeMessages(request, mcpRuntime)
  for await (const event of runAgent(messages, {
    maxTurns: normalizeMaxTurns(request.maxTurns),
    refreshSystemPrompt: async currentMessages => {
      const first = currentMessages[0]
      if (first?.role === 'system') first.content = await buildFreshSystemPrompt(mcpRuntime)
    },
  })) {
    writeJsonl(res, { type: 'agent_event', event })
  }

  writeJsonl(res, { type: 'done', messageCount: messages.length })
  res.end()
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function writeJsonl(res: ServerResponse, output: IdeBridgeOutput): void {
  res.write(`${JSON.stringify(output)}\n`)
}

function writeStartupJson(value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`)
}

function normalizePort(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) return DEFAULT_PORT
  return parsed
}

main().catch(err => {
  stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
