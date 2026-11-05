import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('IDE server runs image requests concurrently within and across sessions', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'jesse-concurrent-session-'))
  const imageResponses: ServerResponse[] = []
  let activeImages = 0
  let maxActiveImages = 0

  const modelServer = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: Array<{ role?: string }>
      tools?: unknown[]
    }

    if (req.url?.startsWith('/v1/images/generations')) {
      activeImages += 1
      maxActiveImages = Math.max(maxActiveImages, activeImages)
      imageResponses.push(res)
      if (imageResponses.length === 2) {
        for (const response of imageResponses.splice(0)) {
          activeImages -= 1
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }))
        }
      }
      return
    }

    const lastRole = body.messages?.at(-1)?.role
    const hasAgentTools = Boolean(body.tools?.length)
    if (!hasAgentTools) {
      writeSse(res, { content: 'Concurrent images' })
    } else if (lastRole === 'tool') {
      writeSse(res, { content: 'Image complete.' })
    } else {
      writeSse(res, {
        tool_calls: [{
          index: 0,
          id: `image-${Math.random().toString(36).slice(2)}`,
          type: 'function',
          function: { name: 'generate_image', arguments: '{"prompt":"parallel image"}' },
        }],
      })
    }
  })
  await new Promise<void>(resolveListen => modelServer.listen(0, '127.0.0.1', resolveListen))
  const address = modelServer.address()
  assert.ok(address && typeof address === 'object')

  process.env.JESSE_IDE_PORT = '0'
  process.env.JESSE_MCP_CONFIG = join(workspaceRoot, 'missing-mcp.json')
  process.env.JESSE_WORKSPACE_HOME = join(workspaceRoot, 'managed-workspaces')
  process.env.LLM_API_MODE = 'chat_completions'
  process.env.LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`
  process.env.LLM_IMAGE_BASE_URL = `http://127.0.0.1:${address.port}/v1/images/generations`
  process.env.LLM_API_KEY = ''

  const { startIdeServer } = await import('./ideServer.js')
  const ideServer = await startIdeServer({ announce: false, registerSignalHandlers: false })

  t.after(async () => {
    await ideServer.close()
    await new Promise<void>(resolveClose => modelServer.close(() => resolveClose()))
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  const port = ideServer.port
  const first = await startRun(port, workspaceRoot, 'create image one')
  const second = await startRun(port, workspaceRoot, 'create image two', first.sessionId)

  assert.equal(first.status, 202)
  assert.equal(second.status, 202)
  assert.equal(second.sessionId, first.sessionId)
  await waitForTerminalRuns(port, [first.runId, second.runId])
  assert.equal(maxActiveImages, 2)

  const sessionResponse = await fetch(`http://127.0.0.1:${port}/session/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceRoot, sessionId: first.sessionId }),
  })
  assert.equal(sessionResponse.status, 200)
  const session = await sessionResponse.json() as {
    messages?: Array<{ role?: string; content?: string; attachments?: unknown[] }>
  }
  assert.equal(session.messages?.filter(message => message.role === 'user').length, 2)
  assert.equal(session.messages?.filter(message => message.role === 'assistant' && message.content === 'Image complete.').length, 2)
  assert.equal(session.messages?.filter(message => message.attachments?.length).length, 2)

  maxActiveImages = 0
  const third = await startRun(port, workspaceRoot, 'create image in session three')
  const fourth = await startRun(port, workspaceRoot, 'create image in session four')
  assert.equal(third.status, 202)
  assert.equal(fourth.status, 202)
  assert.notEqual(third.sessionId, fourth.sessionId)
  await waitForTerminalRuns(port, [third.runId, fourth.runId])
  assert.equal(maxActiveImages, 2)
})

function writeSse(res: ServerResponse, delta: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
}

async function startRun(
  port: number,
  workspaceRoot: string,
  prompt: string,
  sessionId?: string,
): Promise<{ status: number; runId: string; sessionId: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      sessionId,
      permissionMode: 'default',
      context: { workspaceRoot },
    }),
  })
  const body = await response.json() as { runId: string; sessionId: string }
  return { status: response.status, ...body }
}

async function waitForTerminalRuns(port: number, runIds: string[]): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const states = await Promise.all(runIds.map(async runId => {
      const response = await fetch(`http://127.0.0.1:${port}/runs?runId=${encodeURIComponent(runId)}`)
      const body = await response.json() as { runs?: Array<{ status?: string; error?: string }> }
      return body.runs?.[0]
    }))
    if (states.every(run => run && ['completed', 'failed', 'cancelled'].includes(run.status ?? ''))) {
      for (const run of states) assert.equal(run?.status, 'completed', run?.error)
      return
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  assert.fail('Timed out waiting for concurrent runs to finish')
}
