/**
 * mcp.ts - minimal local stdio MCP client.
 *
 * This is intentionally a small Claude Code-shaped core:
 *   .jesse/mcp.json -> stdio server -> tools/list -> mcp__server__tool wrappers.
 *
 * Later HTTP/SSE/OAuth/resources/prompts should extend this boundary instead of
 * leaking MCP details into loop.ts or individual built-in tools.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { resolve } from 'node:path'
import type { JSONSchema, Tool } from './types.js'

const DEFAULT_MCP_CONFIG_PATH = '.jesse/mcp.json'
const MCP_PROTOCOL_VERSION = '2024-11-05'
const MCP_REQUEST_TIMEOUT_MS = 30_000
const MAX_CAPTURED_STDERR_CHARS = 4_000

export interface McpPromptContext {
  configPath: string
  manifest: string
  serverCount: number
  toolCount: number
  errors: string[]
}

export interface McpRuntimeContext {
  tools: Tool[]
  prompt: McpPromptContext
  close: () => Promise<void>
}

interface McpJsonConfig {
  mcpServers: Record<string, McpStdioServerConfig>
}

interface McpStdioServerConfig {
  type: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

interface McpToolSpec {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    openWorldHint?: boolean
    [key: string]: unknown
  }
}

interface McpListToolsResult {
  tools?: unknown[]
  nextCursor?: unknown
}

interface McpCallToolResult {
  content?: unknown[]
  isError?: boolean
  [key: string]: unknown
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Claude Code-compatible MCP name normalization. */
export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`
}

export async function loadMcpRuntimeContext(
  configPath = process.env.JESSE_MCP_CONFIG ?? DEFAULT_MCP_CONFIG_PATH,
): Promise<McpRuntimeContext> {
  const resolvedConfigPath = resolve(process.cwd(), configPath)
  const parsed = await readMcpConfig(resolvedConfigPath, configPath)
  if (!parsed.config) {
    return emptyMcpRuntime(configPath, parsed.errors)
  }

  const clients: McpStdioClient[] = []
  const tools: Tool[] = []
  const manifestLines: string[] = []
  const errors = [...parsed.errors]

  for (const [serverName, serverConfig] of Object.entries(parsed.config.mcpServers)) {
    let client: McpStdioClient | null = null
    try {
      client = new McpStdioClient(serverName, serverConfig)
      await client.initialize()
      const serverTools = await client.listTools()
      clients.push(client)
      manifestLines.push(formatServerManifestLine(serverName, serverTools.length))

      for (const mcpTool of serverTools) {
        const wrapped = wrapMcpTool(client, serverName, mcpTool)
        tools.push(wrapped)
        manifestLines.push(`  - ${wrapped.name}: ${oneLine(mcpTool.description ?? '(no description)')}`)
      }
    } catch (err) {
      if (client) await client.close()
      errors.push(`MCP server "${serverName}" failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const manifest = manifestLines.length > 0
    ? manifestLines.join('\n')
    : '(no MCP tools loaded)'

  return {
    tools,
    prompt: {
      configPath,
      manifest,
      serverCount: clients.length,
      toolCount: tools.length,
      errors,
    },
    async close() {
      await Promise.all(clients.map(client => client.close()))
    },
  }
}

async function readMcpConfig(
  resolvedConfigPath: string,
  displayPath: string,
): Promise<{ config: McpJsonConfig | null; errors: string[] }> {
  let raw: string
  try {
    raw = await readFile(resolvedConfigPath, 'utf8')
  } catch (err) {
    if (isNodeErrorCode(err, 'ENOENT')) return { config: null, errors: [] }
    return { config: null, errors: [`Failed to read ${displayPath}: ${String(err)}`] }
  }

  try {
    const json = JSON.parse(raw)
    return parseMcpConfig(json)
  } catch (err) {
    return { config: null, errors: [`Failed to parse ${displayPath}: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

function parseMcpConfig(json: unknown): { config: McpJsonConfig | null; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(json)) return { config: null, errors: ['MCP config must be a JSON object.'] }
  if (!isRecord(json.mcpServers)) return { config: { mcpServers: {} }, errors }

  const mcpServers: Record<string, McpStdioServerConfig> = {}
  for (const [serverName, rawConfig] of Object.entries(json.mcpServers)) {
    const parsed = parseStdioServerConfig(rawConfig)
    if (typeof parsed === 'string') {
      errors.push(`MCP server "${serverName}" skipped: ${parsed}`)
      continue
    }
    mcpServers[serverName] = parsed
  }

  return { config: { mcpServers }, errors }
}

function parseStdioServerConfig(rawConfig: unknown): McpStdioServerConfig | string {
  if (!isRecord(rawConfig)) return 'config must be an object.'
  const type = rawConfig.type ?? 'stdio'
  if (type !== 'stdio') return `unsupported type "${String(type)}". Only local stdio is supported in this phase.`
  if (typeof rawConfig.command !== 'string' || rawConfig.command.trim() === '') {
    return 'command must be a non-empty string.'
  }

  const args = rawConfig.args === undefined
    ? []
    : Array.isArray(rawConfig.args) && rawConfig.args.every(arg => typeof arg === 'string')
      ? rawConfig.args
      : null
  if (!args) return 'args must be an array of strings.'

  const env = rawConfig.env === undefined ? undefined : parseStringRecord(rawConfig.env)
  if (env === null) return 'env must be an object whose values are strings.'

  const cwd = rawConfig.cwd === undefined
    ? undefined
    : typeof rawConfig.cwd === 'string' && rawConfig.cwd.trim() !== ''
      ? rawConfig.cwd
      : null
  if (cwd === null) return 'cwd must be a non-empty string when provided.'

  return { type: 'stdio', command: rawConfig.command, args, env, cwd }
}

function parseStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  const result: Record<string, string> = {}
  for (const [key, recordValue] of Object.entries(value)) {
    if (typeof recordValue !== 'string') return null
    result[key] = recordValue
  }
  return result
}

function wrapMcpTool(client: McpStdioClient, serverName: string, tool: McpToolSpec): Tool {
  return {
    name: buildMcpToolName(serverName, tool.name),
    description: [
      `MCP tool from server "${serverName}". Original tool name: "${tool.name}".`,
      tool.description ?? '',
    ].filter(Boolean).join('\n'),
    parameters: toToolSchema(tool.inputSchema),
    isReadOnly: tool.annotations?.readOnlyHint === true,
    async execute(args) {
      const result = await client.callTool(tool.name, args)
      return formatMcpToolResult(serverName, tool.name, result)
    },
  }
}

function toToolSchema(inputSchema: unknown): JSONSchema {
  if (!isRecord(inputSchema)) return { type: 'object', properties: {} }
  const properties = isRecord(inputSchema.properties)
    ? inputSchema.properties as Record<string, JSONSchema['properties'][string]>
    : {}
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter(item => typeof item === 'string')
    : undefined

  return {
    ...inputSchema,
    type: 'object',
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  }
}

function formatMcpToolResult(serverName: string, toolName: string, result: McpCallToolResult): string {
  const content = Array.isArray(result.content)
    ? result.content.map(formatMcpContentBlock).filter(Boolean).join('\n')
    : ''
  const fallback = content || JSON.stringify(result, null, 2)
  return result.isError
    ? `MCP tool "${serverName}/${toolName}" returned an error:\n${fallback}`
    : fallback
}

function formatMcpContentBlock(block: unknown): string {
  if (!isRecord(block)) return JSON.stringify(block)
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'image') {
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'unknown mime type'
    return `[MCP image result omitted: ${mimeType}]`
  }
  if (block.type === 'resource') return `[MCP resource result omitted: ${JSON.stringify(block.resource ?? {})}]`
  return JSON.stringify(block)
}

function formatServerManifestLine(serverName: string, toolCount: number): string {
  return `- ${serverName} (${toolCount} tool${toolCount === 1 ? '' : 's'})`
}

function emptyMcpRuntime(configPath: string, errors: string[]): McpRuntimeContext {
  return {
    tools: [],
    prompt: {
      configPath,
      manifest: `(no MCP config found at ${configPath})`,
      serverCount: 0,
      toolCount: 0,
      errors,
    },
    async close() {},
  }
}

class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly stdoutLines: ReadlineInterface
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private closed = false
  private stderrTail = ''

  constructor(
    private readonly serverName: string,
    private readonly config: McpStdioServerConfig,
  ) {
    this.child = spawn(config.command, config.args, {
      cwd: config.cwd ? resolve(process.cwd(), config.cwd) : process.cwd(),
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => this.captureStderr(String(chunk)))
    this.child.on('error', err => this.failPending(new Error(`process error: ${err.message}`)))
    this.child.on('exit', (code, signal) => {
      if (!this.closed) {
        this.failPending(new Error(`process exited with code=${code ?? 'null'} signal=${signal ?? 'null'}${this.stderrSuffix()}`))
      }
    })

    this.stdoutLines = createInterface({ input: this.child.stdout })
    this.stdoutLines.on('line', line => this.handleLine(line))
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'jesse-agent', version: '0.1.0' },
    })
    this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpToolSpec[]> {
    const tools: McpToolSpec[] = []
    let cursor: string | undefined

    do {
      const result = await this.request<McpListToolsResult>(
        'tools/list',
        cursor ? { cursor } : {},
      )
      for (const rawTool of result.tools ?? []) {
        const parsed = parseMcpToolSpec(rawTool)
        if (parsed) tools.push(parsed)
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined
    } while (cursor)

    return tools
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    return this.request<McpCallToolResult>('tools/call', {
      name: toolName,
      arguments: args,
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stdoutLines.close()
    this.failPending(new Error('MCP client closed.'))

    if (this.child.exitCode !== null || this.child.killed) return
    await new Promise<void>(resolveClose => {
      const timer = setTimeout(() => {
        if (!this.child.killed) this.child.kill('SIGKILL')
        resolveClose()
      }, 1_000)
      timer.unref()
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolveClose()
      })
      this.child.kill()
    })
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params

    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error(`MCP request "${method}" timed out after ${MCP_REQUEST_TIMEOUT_MS}ms${this.stderrSuffix()}`))
      }, MCP_REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        timer,
        resolve: value => resolveRequest(value as T),
        reject: rejectRequest,
      })

      this.writeMessage(message, err => {
        if (!err) return
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(err)
      })
    })
  }

  private notify(method: string, params?: unknown): void {
    const message: JsonRpcMessage = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    this.writeMessage(message)
  }

  private writeMessage(message: JsonRpcMessage, onError?: (err: Error | null) => void): void {
    if (this.closed || this.child.stdin.destroyed) {
      onError?.(new Error(`MCP server "${this.serverName}" stdin is closed.`))
      return
    }

    const payload = `${JSON.stringify(message)}\n`
    this.child.stdin.write(payload, err => onError?.(err ?? null))
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }

    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)

    if (message.error) {
      pending.reject(new Error(`MCP error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`.trim()))
      return
    }
    pending.resolve(message.result)
  }

  private failPending(err: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(err)
    }
  }

  private captureStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-MAX_CAPTURED_STDERR_CHARS)
  }

  private stderrSuffix(): string {
    const stderr = this.stderrTail.trim()
    return stderr ? `\nstderr:\n${stderr}` : ''
  }
}

function parseMcpToolSpec(rawTool: unknown): McpToolSpec | null {
  if (!isRecord(rawTool) || typeof rawTool.name !== 'string' || rawTool.name.trim() === '') {
    return null
  }

  const annotations = isRecord(rawTool.annotations)
    ? rawTool.annotations as McpToolSpec['annotations']
    : undefined

  return {
    name: rawTool.name,
    description: typeof rawTool.description === 'string' ? rawTool.description : undefined,
    inputSchema: rawTool.inputSchema,
    annotations,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 180 ? `${collapsed.slice(0, 180)}...` : collapsed
}
