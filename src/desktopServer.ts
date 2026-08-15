/**
 * desktopServer.ts - local desktop web shell for Jesse Agent.
 *
 * This is intentionally a thin frontend server. It serves the built React UI and
 * proxies requests to the existing long-lived IDE server so desktop, VS Code,
 * and future IM clients share the same agent core and approval protocol.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { cwd, stderr, stdout } from 'node:process'
import {
  defaultRoutineSchedule,
  ROUTINE_TEMPLATES,
  type RoutineDefinition,
  type RoutineRunSummary,
} from './routineTypes.js'
import { listQuickTasks, parseQuickTaskInput, runQuickTask } from './quickTasks.js'
import { managedWorkspaceRoots } from './workspaces.js'
import { prepareProductDataHome, productDataHome } from './productData.js'
import {
  dailyChangelogImagePath,
  finalizeDueChangelogs,
  listDailyChangelogs,
  readDailyChangelog,
} from './changelog.js'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const DESKTOP_API_VERSION = 3
const DESKTOP_CAPABILITIES = [
  'quick-tasks-v1',
  'chat-v1',
  'do-anything-v1',
  'agent-runs-v1',
  'scoped-run-control-v1',
  'managed-workspaces-v1',
  'daily-changelog-v1',
]
// A 16 MB image expands to about 21.4 MB when base64-encoded in JSON.
// Match the IDE bridge limit so the composer's documented image limit works.
const MAX_BODY_BYTES = 24 * 1024 * 1024
const AGENT_ROOT = cwd()
const DATA_HOME = productDataHome()
const STATIC_ROOT = resolve(process.env.JESSE_WEB_ROOT?.trim() || join(AGENT_ROOT, 'desktop-app', 'dist'))
const CHAT_ROOT = join(DATA_HOME, 'chat')
const PROJECTS_FILE = join(DATA_HOME, 'desktop-projects.json')
const ROUTINES_FILE = join(DATA_HOME, 'desktop-routines.json')
const ROUTINE_RUNS_FILE = join(DATA_HOME, 'desktop-routine-runs.json')

interface IdeServerHandle {
  process: ChildProcess
  host: string
  port: number
}

interface DesktopProject {
  name: string
  path: string
  lastUsedAt: string
  source: 'agentRoot' | 'manual' | 'selected'
}

type DesktopRoutine = RoutineDefinition

let ideServer: IdeServerHandle | null = null
let ideServerStartPromise: Promise<IdeServerHandle> | null = null
let routineSchedulerTimer: NodeJS.Timeout | null = null
let changelogSchedulerTimer: NodeJS.Timeout | null = null
let changelogSchedulerRunning = false

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    stdout.write([
      'Usage: npm run desktop',
      '',
      'Starts a local web desktop shell at http://127.0.0.1:8787 by default.',
      'Set JESSE_DESKTOP_PORT to choose a different port.',
      '',
    ].join('\n'))
    return
  }

  await prepareProductDataHome(AGENT_ROOT, DATA_HOME)
  await ensureAgentRootProject()
  await mkdir(CHAT_ROOT, { recursive: true })
  startRoutineScheduler()
  startChangelogScheduler()

  const server = createServer((req, res) => {
    void routeRequest(req, res)
  })

  const port = normalizePort(process.env.JESSE_DESKTOP_PORT)
  server.listen(port, HOST, () => {
    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : port
    stdout.write(`Jesse Agent desktop: http://${HOST}:${actualPort}\n`)
  })

  const close = () => {
    if (routineSchedulerTimer) clearInterval(routineSchedulerTimer)
    routineSchedulerTimer = null
    if (changelogSchedulerTimer) clearInterval(changelogSchedulerTimer)
    changelogSchedulerTimer = null
    ideServer?.process.kill()
    ideServer = null
    server.close()
  }
  process.once('SIGINT', () => { close(); process.exit(0) })
  process.once('SIGTERM', () => { close(); process.exit(0) })
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}`)

    if (req.method === 'GET' && url.pathname === '/api/health') {
      writeJson(res, 200, {
        ok: true,
        service: 'jesse-desktop',
        apiVersion: DESKTOP_API_VERSION,
        capabilities: DESKTOP_CAPABILITIES,
        serviceVersion: process.env.npm_package_version || '0.1.0',
        agentRoot: AGENT_ROOT,
        dataHome: DATA_HOME,
        webRoot: STATIC_ROOT,
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/projects') {
      writeJson(res, 200, { projects: await listProjects() })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/chat') {
      writeJson(res, 200, { workspaceRoot: CHAT_ROOT })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/quick-tasks') {
      writeJson(res, 200, { tasks: listQuickTasks() })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/changelogs') {
      const projectRoot = await registeredChangelogProject(url)
      const requestedLimit = Number(url.searchParams.get('limit') ?? 5)
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 5
      writeJson(res, 200, { changelogs: await listDailyChangelogs(projectRoot, limit) })
      return
    }

    const changelogImageMatch = /^\/api\/changelogs\/(\d{4}-\d{2}-\d{2})\/image$/.exec(url.pathname)
    if (req.method === 'GET' && changelogImageMatch?.[1]) {
      const projectRoot = await registeredChangelogProject(url)
      const imagePath = await dailyChangelogImagePath(projectRoot, changelogImageMatch[1])
      if (!imagePath) {
        writeJson(res, 404, { error: 'changelog illustration not found' })
        return
      }
      await serveFile(imagePath, res)
      return
    }

    const changelogDetailMatch = /^\/api\/changelogs\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname)
    if (req.method === 'GET' && changelogDetailMatch?.[1]) {
      const projectRoot = await registeredChangelogProject(url)
      const changelog = await readDailyChangelog(projectRoot, changelogDetailMatch[1])
      if (!changelog) {
        writeJson(res, 404, { error: 'changelog not found' })
        return
      }
      writeJson(res, 200, { changelog })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/agent-status') {
      await proxyToIdeServer(req, res, '/health')
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/quick-tasks') {
      const input = parseQuickTaskInput(await readJsonBody(req))
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for await (const event of runQuickTask(input)) {
        res.write(`${JSON.stringify(event)}\n`)
      }
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/do-anything') {
      const input = await readJsonBody(req)
      const incomingContext = input.context && typeof input.context === 'object'
        ? input.context as Record<string, unknown>
        : {}
      await proxyJsonToIdeServer(res, '/runs', {
        ...input,
        context: {
          ...incomingContext,
          workspaceRoot: CHAT_ROOT,
          chatMode: true,
          origin: 'shortcut',
        },
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/projects/pick') {
      const projectPath = await pickProjectFolder()
      if (!projectPath) {
        writeJson(res, 200, { canceled: true })
        return
      }
      const project = await registerProject(projectPath, 'selected')
      writeJson(res, 200, { canceled: false, projectPath: project.path })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/workspaces/pick') {
      const workspacePath = await pickProjectFolder()
      if (!workspacePath) {
        writeJson(res, 200, { canceled: true })
        return
      }
      writeJson(res, 200, { canceled: false, workspaceRoot: await resolveRoutineWorkspace(workspacePath) })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/workspaces/reveal') {
      const body = await readJsonBody(req)
      const workspacePath = readString(body.path)
      if (!workspacePath) {
        writeJson(res, 400, { error: 'path is required' })
        return
      }
      await revealWorkspace(workspacePath)
      writeJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const body = await readJsonBody(req)
      const projectPath = readString(body.path)
      if (!projectPath) {
        writeJson(res, 400, { error: 'path is required' })
        return
      }
      await registerProject(projectPath, 'manual')
      writeJson(res, 200, { projects: await listProjects() })
      return
    }

    if (req.method === 'DELETE' && url.pathname === '/api/projects') {
      const body = await readJsonBody(req)
      const projectPath = readString(body.path)
      if (!projectPath) {
        writeJson(res, 400, { error: 'path is required' })
        return
      }
      await removeProject(projectPath)
      writeJson(res, 200, { projects: await listProjects() })
      return
    }

    if (req.method === 'PATCH' && url.pathname === '/api/projects') {
      const body = await readJsonBody(req)
      const projectPath = readString(body.path)
      const projectName = readString(body.name)
      if (!projectPath || !projectName) {
        writeJson(res, 400, { error: 'path and name are required' })
        return
      }
      if (projectName.length > 80) {
        writeJson(res, 400, { error: 'name must be 80 characters or fewer' })
        return
      }
      await renameProject(projectPath, projectName)
      writeJson(res, 200, { projects: await listProjects() })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/projects/select') {
      const body = await readJsonBody(req)
      const projectPath = readString(body.path)
      if (!projectPath) {
        writeJson(res, 400, { error: 'path is required' })
        return
      }
      await registerProject(projectPath, 'selected')
      writeJson(res, 200, { projects: await listProjects() })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/routines') {
      writeJson(res, 200, { routines: await listRoutines() })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/routine-templates') {
      writeJson(res, 200, { templates: ROUTINE_TEMPLATES })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/routine-runs') {
      const routineId = url.searchParams.get('routineId') ?? undefined
      writeJson(res, 200, { runs: await listRoutineRuns(routineId) })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/routines') {
      const body = await readJsonBody(req)
      const name = readString(body.name)
      if (!name) {
        writeJson(res, 400, { error: 'name is required' })
        return
      }
      if (name.length > 80) {
        writeJson(res, 400, { error: 'name must be 80 characters or fewer' })
        return
      }
      const routine = await createRoutine({
        name,
        description: readString(body.description) ?? '',
        scheduleText: readString(body.scheduleText) ?? '',
        instruction: readString(body.instruction) ?? '',
        workspaceRoot: readString(body.workspaceRoot),
      })
      writeJson(res, 200, { routine, routines: await listRoutines() })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/routines/from-template') {
      const body = await readJsonBody(req)
      const templateId = readString(body.templateId)
      if (!templateId) {
        writeJson(res, 400, { error: 'templateId is required' })
        return
      }
      const routine = await createRoutineFromTemplate(templateId, readString(body.workspaceRoot))
      writeJson(res, 200, { routine, routines: await listRoutines() })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/routines/select') {
      const body = await readJsonBody(req)
      const id = readString(body.id)
      if (!id) {
        writeJson(res, 400, { error: 'id is required' })
        return
      }
      const routine = await touchRoutine(id)
      writeJson(res, 200, { routine, routines: await listRoutines() })
      return
    }

    if (req.method === 'PATCH' && url.pathname === '/api/routines') {
      const body = await readJsonBody(req)
      const id = readString(body.id)
      if (!id) {
        writeJson(res, 400, { error: 'id is required' })
        return
      }
      const routine = await updateRoutine(id, body)
      writeJson(res, 200, { routine, routines: await listRoutines() })
      return
    }

    if (req.method === 'DELETE' && url.pathname === '/api/routines') {
      const body = await readJsonBody(req)
      const id = readString(body.id)
      if (!id) {
        writeJson(res, 400, { error: 'id is required' })
        return
      }
      await removeRoutine(id)
      writeJson(res, 200, { routines: await listRoutines() })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/routines/run') {
      const body = await readJsonBody(req)
      const id = readString(body.id)
      if (!id) {
        writeJson(res, 400, { error: 'id is required' })
        return
      }
      const run = await startRoutineRun(id)
      writeJson(res, 200, { run, runs: await listRoutineRuns(id), routines: await listRoutines() })
      return
    }

    if (url.pathname.startsWith('/api/')) {
      await proxyToIdeServer(req, res, url.pathname.slice('/api'.length) + url.search)
      return
    }

    await serveStatic(url.pathname, res)
  } catch (error) {
    if (!res.headersSent) writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    else res.end()
  }
}

async function ensureIdeServer(): Promise<IdeServerHandle> {
  if (ideServer?.process.exitCode === null) return ideServer
  if (ideServerStartPromise) return ideServerStartPromise

  ideServerStartPromise = new Promise((resolveReady, rejectReady) => {
    const packagedEntry = process.env.JESSE_IDE_SERVER_ENTRY?.trim()
    const executable = packagedEntry ? (process.env.JESSE_NODE_PATH?.trim() || process.execPath) : npmCommand()
    const args = packagedEntry ? [packagedEntry] : ['run', 'ide:server', '--silent']
    const child = spawn(executable, args, {
      cwd: AGENT_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutBuffer = ''
    let stderrText = ''
    const timer = setTimeout(() => {
      child.kill()
      rejectReady(new Error(stderrText.trim() || 'Timed out starting Jesse Agent IDE server.'))
    }, 15_000)

    child.stdout?.on('data', chunk => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line) as { type?: string; host?: string; port?: number }
          if (message.type === 'server_ready' && typeof message.port === 'number') {
            clearTimeout(timer)
            const handle = { process: child, host: message.host || HOST, port: message.port }
            ideServer = handle
            resolveReady(handle)
          }
        } catch {
          // Non-JSON stdout is ignored; server readiness is a JSON line.
        }
      }
    })

    child.stderr?.on('data', chunk => {
      stderrText += chunk.toString('utf8')
      stderr.write(chunk)
    })
    child.on('error', error => {
      clearTimeout(timer)
      rejectReady(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (ideServer?.process === child) ideServer = null
      ideServerStartPromise = null
      if (!ideServer && code !== 0) rejectReady(new Error(stderrText.trim() || `IDE server exited with code ${code}`))
    })
  })

  try {
    return await ideServerStartPromise
  } finally {
    ideServerStartPromise = null
  }
}

async function proxyToIdeServer(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const server = await ensureIdeServer()
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)

  await new Promise<void>((resolveProxy, rejectProxy) => {
    const proxied = httpRequest({
      host: server.host,
      port: server.port,
      path,
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        ...(req.headers['last-event-id'] ? { 'last-event-id': req.headers['last-event-id'] } : {}),
        ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
      },
    }, response => {
      res.writeHead(response.statusCode ?? 500, {
        'content-type': response.headers['content-type'] || 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      })
      response.on('data', chunk => res.write(chunk))
      response.on('end', () => { res.end(); resolveProxy() })
    })

    proxied.on('error', rejectProxy)
    if (body !== undefined) proxied.write(body)
    proxied.end()
  })
}

async function proxyJsonToIdeServer(res: ServerResponse, path: string, value: unknown): Promise<void> {
  const server = await ensureIdeServer()
  const body = JSON.stringify(value)
  await new Promise<void>((resolveProxy, rejectProxy) => {
    const proxied = httpRequest({
      host: server.host,
      port: server.port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      res.writeHead(response.statusCode ?? 500, {
        'content-type': response.headers['content-type'] || 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      })
      response.on('data', chunk => res.write(chunk))
      response.on('end', () => { res.end(); resolveProxy() })
    })
    proxied.on('error', rejectProxy)
    proxied.write(body)
    proxied.end()
  })
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resolved = resolve(STATIC_ROOT, relativePath)
  if (resolved !== STATIC_ROOT && !resolved.startsWith(STATIC_ROOT + sep)) {
    writeJson(res, 403, { error: 'forbidden' })
    return
  }

  await serveFile(resolved, res)
}

async function serveFile(filePath: string, res: ServerResponse): Promise<void> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    writeJson(res, 404, { error: 'not found' })
    return
  }

  res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' })
  createReadStream(filePath).pipe(res)
}

async function listProjects(): Promise<DesktopProject[]> {
  const registered = await readProjectsFile()
  const merged = new Map<string, DesktopProject>()
  const candidates = registered.length > 0 ? registered : [projectFromPath(AGENT_ROOT, 'agentRoot')]
  for (const project of candidates) {
    if (await isDirectory(project.path)) merged.set(project.path, project)
  }
  return [...merged.values()].sort((a, b) => Date.parse(b.lastUsedAt || '0') - Date.parse(a.lastUsedAt || '0'))
}

async function registerProject(projectPath: string, source: DesktopProject['source']): Promise<DesktopProject> {
  const resolved = resolve(projectPath)
  if (!await isDirectory(resolved)) throw new Error(`Project folder does not exist: ${resolved}`)
  const projects = await readProjectsFile()
  const existing = projects.find(project => project.path === resolved)
  const current = projects.filter(project => project.path !== resolved)
  const project = {
    ...projectFromPath(resolved, source),
    name: existing?.name || basename(resolved) || resolved,
  }
  current.unshift(project)
  await mkdir(DATA_HOME, { recursive: true })
  await writeFile(PROJECTS_FILE, JSON.stringify(current.slice(0, 50), null, 2) + '\n', 'utf8')
  return project
}

async function pickProjectFolder(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    throw new Error('The system folder picker is currently available on macOS only.')
  }

  const script = [
    'try',
    'set selectedFolder to choose folder with prompt "Choose a project folder"',
    'return POSIX path of selectedFolder',
    'on error number -128',
    'return ""',
    'end try',
  ].join('\n')

  return await new Promise<string | null>((resolvePicker, rejectPicker) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let errorOutput = ''

    child.stdout?.on('data', chunk => { output += chunk.toString('utf8') })
    child.stderr?.on('data', chunk => { errorOutput += chunk.toString('utf8') })
    child.on('error', rejectPicker)
    child.on('close', code => {
      if (code !== 0) {
        rejectPicker(new Error(errorOutput.trim() || `Folder picker exited with code ${code}`))
        return
      }
      resolvePicker(output.trim() || null)
    })
  })
}

async function revealWorkspace(workspacePath: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Reveal in Finder is currently available on macOS only.')
  const resolvedPath = resolve(workspacePath)
  if (!await isDirectory(resolvedPath)) throw new Error(`Workspace folder does not exist: ${resolvedPath}`)

  const roots = managedWorkspaceRoots()
  const registered = await readProjectsFile()
  const allowedRoots = [roots.scratch, roots.projects, ...registered.map(project => project.path)]
  if (!allowedRoots.some(root => resolvedPath === resolve(root) || resolvedPath.startsWith(resolve(root) + sep))) {
    throw new Error('Workspace is not managed or registered by JesseAgent.')
  }

  const child = spawn('/usr/bin/open', [resolvedPath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function renameProject(projectPath: string, name: string): Promise<void> {
  const resolved = resolve(projectPath)
  const current = await readProjectsFile()
  const project = current.find(item => item.path === resolved)
  if (!project) throw new Error(`Project is not registered: ${resolved}`)
  project.name = name
  await mkdir(DATA_HOME, { recursive: true })
  await writeFile(PROJECTS_FILE, JSON.stringify(current.slice(0, 50), null, 2) + '\n', 'utf8')
}

async function removeProject(projectPath: string): Promise<void> {
  const resolved = resolve(projectPath)
  const current = (await readProjectsFile()).filter(project => project.path !== resolved)
  await mkdir(DATA_HOME, { recursive: true })
  await writeFile(PROJECTS_FILE, JSON.stringify(current.slice(0, 50), null, 2) + '\n', 'utf8')
}

async function listRoutines(): Promise<DesktopRoutine[]> {
  return (await readRoutinesFile())
    .sort((a, b) => Date.parse(b.lastUsedAt || '0') - Date.parse(a.lastUsedAt || '0'))
}

async function createRoutine(input: {
  name: string
  description: string
  scheduleText: string
  instruction: string
  workspaceRoot?: string
}): Promise<DesktopRoutine> {
  const now = new Date().toISOString()
  const routine: DesktopRoutine = {
    id: createRoutineId(),
    name: input.name.trim(),
    description: input.description.trim(),
    enabled: true,
    schedule: parseScheduleText(input.scheduleText),
    scheduleText: input.scheduleText.trim(),
    instruction: input.instruction.trim(),
    workspaceRoot: await resolveRoutineWorkspace(input.workspaceRoot),
    connectors: [],
    workflow: [],
    approvalPolicy: 'ask_before_write',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  }
  const current = await readRoutinesFile()
  await writeRoutinesFile([routine, ...current].slice(0, 100))
  return routine
}

async function createRoutineFromTemplate(templateId: string, workspaceRoot: string | undefined): Promise<DesktopRoutine> {
  const template = ROUTINE_TEMPLATES.find(item => item.id === templateId)
  if (!template) throw new Error(`Unknown routine template: ${templateId}`)
  const now = new Date().toISOString()
  const routine: DesktopRoutine = {
    id: createRoutineId(),
    name: template.name,
    description: template.description,
    enabled: true,
    schedule: template.schedule,
    scheduleText: template.scheduleText,
    instruction: template.instruction,
    workspaceRoot: await resolveRoutineWorkspace(workspaceRoot),
    connectors: template.connectors,
    workflow: template.workflow,
    approvalPolicy: template.approvalPolicy,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  }
  const current = await readRoutinesFile()
  await writeRoutinesFile([routine, ...current].slice(0, 100))
  return routine
}

async function touchRoutine(id: string): Promise<DesktopRoutine> {
  const current = await readRoutinesFile()
  const routine = current.find(item => item.id === id)
  if (!routine) throw new Error(`Routine is not registered: ${id}`)
  routine.lastUsedAt = new Date().toISOString()
  await writeRoutinesFile(current)
  return routine
}

async function updateRoutine(id: string, body: Record<string, unknown>): Promise<DesktopRoutine> {
  const current = await readRoutinesFile()
  const routine = current.find(item => item.id === id)
  if (!routine) throw new Error(`Routine is not registered: ${id}`)

  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (!name) throw new Error('name is required')
    if (name.length > 80) throw new Error('name must be 80 characters or fewer')
    routine.name = name
  }
  if (typeof body.description === 'string') routine.description = body.description.trim()
  if (typeof body.scheduleText === 'string') routine.scheduleText = body.scheduleText.trim()
  if (typeof body.instruction === 'string') routine.instruction = body.instruction.trim()
  if (typeof body.workspaceRoot === 'string') routine.workspaceRoot = await resolveRoutineWorkspace(body.workspaceRoot)
  if (typeof body.enabled === 'boolean') routine.enabled = body.enabled
  if (typeof body.scheduleText === 'string') routine.schedule = parseScheduleText(body.scheduleText)
  if (typeof body.approvalPolicy === 'string') {
    if (body.approvalPolicy === 'read_only_auto' || body.approvalPolicy === 'ask_before_write' || body.approvalPolicy === 'ask_before_external_action') {
      routine.approvalPolicy = body.approvalPolicy
    }
  }
  if (Array.isArray(body.connectors)) routine.connectors = body.connectors.flatMap(item => normalizeConnector(item))
  if (Array.isArray(body.workflow)) routine.workflow = body.workflow.flatMap(item => normalizeWorkflowStep(item))
  routine.lastUsedAt = new Date().toISOString()
  routine.updatedAt = routine.lastUsedAt

  await writeRoutinesFile(current)
  return routine
}

async function startRoutineRun(id: string): Promise<RoutineRunSummary> {
  const routines = await readRoutinesFile()
  const routine = routines.find(item => item.id === id)
  if (!routine) throw new Error(`Routine is not registered: ${id}`)

  const startedAt = new Date().toISOString()
  const run: RoutineRunSummary = {
    id: createRoutineRunId(),
    routineId: routine.id,
    status: 'running',
    startedAt,
    output: 'Routine run started.',
  }
  await upsertRoutineRun(run)

  try {
    const result = await runRoutineThroughIde(routine)
    run.status = result.needsApproval ? 'needs_approval' : result.ok ? 'completed' : 'failed'
    run.finishedAt = new Date().toISOString()
    run.sessionId = result.sessionId
    run.output = result.output
    run.error = result.ok ? undefined : result.output
  } catch (error) {
    run.status = 'failed'
    run.finishedAt = new Date().toISOString()
    run.output = error instanceof Error ? error.message : String(error)
    run.error = run.output
  }

  routine.lastRunAt = run.finishedAt ?? startedAt
  routine.lastUsedAt = routine.lastRunAt
  routine.updatedAt = routine.lastRunAt
  await writeRoutinesFile(routines)
  await upsertRoutineRun(run)
  return run
}

function startRoutineScheduler(): void {
  if (routineSchedulerTimer) return
  void triggerDueRoutines()
  routineSchedulerTimer = setInterval(() => {
    void triggerDueRoutines()
  }, 60_000)
}

function startChangelogScheduler(): void {
  if (changelogSchedulerTimer) return
  void triggerDueChangelogs()
  changelogSchedulerTimer = setInterval(() => {
    void triggerDueChangelogs()
  }, 60_000)
}

async function triggerDueChangelogs(): Promise<void> {
  if (changelogSchedulerRunning) return
  changelogSchedulerRunning = true
  try {
    const projects = await listProjects()
    for (const project of projects) {
      try {
        await finalizeDueChangelogs(project.path, { configRoot: DATA_HOME })
      } catch (error) {
        stderr.write(`changelog ${project.path} failed: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  } finally {
    changelogSchedulerRunning = false
  }
}

async function triggerDueRoutines(): Promise<void> {
  const now = new Date()
  const routines = await readRoutinesFile()
  const due = routines.filter(routine => isRoutineDue(routine, now))
  for (const routine of due) {
    void startRoutineRun(routine.id).catch(error => {
      stderr.write(`routine ${routine.id} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }
}

function isRoutineDue(routine: DesktopRoutine, now: Date): boolean {
  if (!routine.enabled || routine.schedule.kind !== 'daily' || !routine.schedule.time) return false
  const [hourText, minuteText] = routine.schedule.time.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (now.getHours() !== hour || now.getMinutes() !== minute) return false
  if (!routine.lastRunAt) return true
  const lastRun = new Date(routine.lastRunAt)
  return !sameLocalDate(lastRun, now)
}

function sameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

async function runRoutineThroughIde(routine: DesktopRoutine): Promise<{
  ok: boolean
  needsApproval: boolean
  sessionId?: string
  output: string
}> {
  const server = await ensureIdeServer()
  const workflowText = routine.workflow.length > 0
    ? routine.workflow.map((step, index) => [
      `${index + 1}. ${step.title} [${step.kind}]`,
      `connectorIds: ${step.connectorIds.join(', ') || '(none)'}`,
      `config: ${formatWorkflowConfig(step.config)}`,
      step.prompt,
    ].join('\n')).join('\n\n')
    : 'No explicit workflow steps configured. Follow the saved instruction directly.'
  const connectorText = routine.connectors.length > 0
    ? routine.connectors.map(connector => [
      `- ${connector.displayName}`,
      `  kind: ${connector.kind}`,
      `  capabilities: ${connector.capabilities.join(', ') || '(none)'}`,
      `  config: ${formatConnectorConfig(connector.config)}`,
      `  enabled: ${connector.enabled ? 'yes' : 'no'}`,
    ].join('\n')).join('\n')
    : '(none configured)'

  const body = JSON.stringify({
    prompt: [
      'Run this Routine now.',
      '',
      '# Routine Instruction',
      routine.instruction || '(not set)',
      '',
      '# Generic Connectors',
      connectorText,
      '',
      '# Workflow',
      workflowText,
      '',
      '# Boundaries',
      '- Treat connectors as generic capability descriptors, not product-specific hard-coding.',
      '- Use available MCP/API tools that match the required capabilities.',
      `- Approval policy: ${routine.approvalPolicy}.`,
      '- Do not write files or take external actions unless the normal approval flow allows it.',
    ].join('\n'),
    permissionMode: 'default',
    maxTurns: 12,
    context: {
      workspaceRoot: routine.workspaceRoot,
      routineName: routine.name,
      routineSchedule: routine.scheduleText || 'Manual',
      routineInstruction: routine.instruction || '(not set)',
    },
  })

  return await new Promise((resolveRun, rejectRun) => {
    const request = httpRequest({
      host: server.host,
      port: server.port,
      path: '/ask',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      let buffer = ''
      let finalText = ''
      let errorText = ''
      let sessionId: string | undefined
      let needsApproval = false

      response.on('data', chunk => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) consumeRoutineRunLine(line)
      })
      response.on('end', () => {
        if (buffer.trim()) consumeRoutineRunLine(buffer)
        const ok = (response.statusCode ?? 500) < 400 && !errorText && !needsApproval
        const output = needsApproval
          ? 'Routine paused because it needs approval for a write or external action. Open the generated session to review and continue manually.'
          : finalText.trim() || errorText.trim() || `IDE server returned ${response.statusCode}`
        resolveRun({ ok, needsApproval, sessionId, output })
      })

      function consumeRoutineRunLine(line: string): void {
        if (!line.trim()) return
        try {
          const message = JSON.parse(line) as {
            type?: string
            sessionId?: string
            error?: string
            request?: { id?: string }
            event?: { type?: string; text?: string; reason?: string }
          }
          if (message.sessionId) sessionId = message.sessionId
          if (message.type === 'error' && message.error) errorText += `${message.error}\n`
          if (message.type === 'approval_request' && message.request?.id) {
            needsApproval = true
            void resolveRoutineApproval(server, message.request.id)
          }
          if (message.event?.type === 'assistant_text' && message.event.text) finalText = message.event.text
          if (message.event?.type === 'error' && message.event.reason) errorText += `${message.event.reason}\n`
        } catch {
          errorText += `${line}\n`
        }
      }
    })

    request.on('error', rejectRun)
    request.write(body)
    request.end()
  })
}

async function resolveRoutineApproval(server: IdeServerHandle, id: string): Promise<void> {
  const body = JSON.stringify({ id, choice: 'reject_once' })
  await new Promise<void>(resolveApproval => {
    const approval = httpRequest({
      host: server.host,
      port: server.port,
      path: '/approval',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      response.resume()
      response.on('end', resolveApproval)
    })
    approval.on('error', () => resolveApproval())
    approval.write(body)
    approval.end()
  })
}

async function listRoutineRuns(routineId?: string): Promise<RoutineRunSummary[]> {
  const runs = await readRoutineRunsFile()
  return runs
    .filter(run => !routineId || run.routineId === routineId)
    .sort((a, b) => Date.parse(b.startedAt || '0') - Date.parse(a.startedAt || '0'))
    .slice(0, 50)
}

async function upsertRoutineRun(run: RoutineRunSummary): Promise<void> {
  const current = await readRoutineRunsFile()
  const next = [run, ...current.filter(item => item.id !== run.id)].slice(0, 500)
  await writeRoutineRunsFile(next)
}

async function readRoutineRunsFile(): Promise<RoutineRunSummary[]> {
  try {
    const raw = await readFile(ROUTINE_RUNS_FILE, 'utf8')
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap(item => normalizeRoutineRun(item))
  } catch {
    return []
  }
}

async function writeRoutineRunsFile(runs: RoutineRunSummary[]): Promise<void> {
  await mkdir(DATA_HOME, { recursive: true })
  await writeFile(ROUTINE_RUNS_FILE, JSON.stringify(runs.slice(0, 500), null, 2) + '\n', 'utf8')
}

function normalizeRoutineRun(value: unknown): RoutineRunSummary[] {
  if (!value || typeof value !== 'object') return []
  const item = value as Partial<RoutineRunSummary>
  if (typeof item.id !== 'string' || typeof item.routineId !== 'string') return []
  return [{
    id: item.id,
    routineId: item.routineId,
    status: item.status === 'queued' || item.status === 'running' || item.status === 'completed' || item.status === 'failed' || item.status === 'needs_approval'
      ? item.status
      : 'failed',
    startedAt: typeof item.startedAt === 'string' ? item.startedAt : new Date().toISOString(),
    finishedAt: typeof item.finishedAt === 'string' ? item.finishedAt : undefined,
    sessionId: typeof item.sessionId === 'string' ? item.sessionId : undefined,
    output: typeof item.output === 'string' ? item.output : '',
    error: typeof item.error === 'string' ? item.error : undefined,
  }]
}

async function removeRoutine(id: string): Promise<void> {
  const current = (await readRoutinesFile()).filter(routine => routine.id !== id)
  await writeRoutinesFile(current)
}

async function readRoutinesFile(): Promise<DesktopRoutine[]> {
  try {
    const raw = await readFile(ROUTINES_FILE, 'utf8')
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap(item => normalizeRoutine(item))
  } catch {
    return []
  }
}

async function writeRoutinesFile(routines: DesktopRoutine[]): Promise<void> {
  await mkdir(DATA_HOME, { recursive: true })
  await writeFile(ROUTINES_FILE, JSON.stringify(routines.slice(0, 100), null, 2) + '\n', 'utf8')
}

function normalizeRoutine(value: unknown): DesktopRoutine[] {
  if (!value || typeof value !== 'object') return []
  const item = value as Partial<DesktopRoutine>
  if (typeof item.id !== 'string' || !item.id.trim()) return []
  if (typeof item.name !== 'string' || !item.name.trim()) return []
  const now = new Date().toISOString()
  const scheduleText = typeof item.scheduleText === 'string' ? item.scheduleText.trim() : ''
  return [{
    id: item.id.trim(),
    name: item.name.trim(),
    description: typeof item.description === 'string' ? item.description.trim() : '',
    enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
    schedule: item.schedule && typeof item.schedule === 'object' ? item.schedule : parseScheduleText(scheduleText),
    scheduleText,
    instruction: typeof item.instruction === 'string' ? item.instruction.trim() : '',
    workspaceRoot: typeof item.workspaceRoot === 'string' && item.workspaceRoot.trim()
      ? resolve(item.workspaceRoot)
      : AGENT_ROOT,
    connectors: Array.isArray(item.connectors) ? item.connectors.flatMap(connector => normalizeConnector(connector)) : [],
    workflow: Array.isArray(item.workflow) ? item.workflow.flatMap(step => normalizeWorkflowStep(step)) : [],
    approvalPolicy: item.approvalPolicy === 'read_only_auto' || item.approvalPolicy === 'ask_before_write' || item.approvalPolicy === 'ask_before_external_action'
      ? item.approvalPolicy
      : 'ask_before_write',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
    lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : now,
    lastRunAt: typeof item.lastRunAt === 'string' ? item.lastRunAt : undefined,
    nextRunAt: typeof item.nextRunAt === 'string' ? item.nextRunAt : undefined,
  }]
}

function normalizeConnector(value: unknown): DesktopRoutine['connectors'] {
  if (!value || typeof value !== 'object') return []
  const item = value as Partial<DesktopRoutine['connectors'][number]>
  if (typeof item.id !== 'string' || !item.id.trim()) return []
  if (typeof item.displayName !== 'string' || !item.displayName.trim()) return []
  return [{
    id: item.id.trim(),
    kind: item.kind === 'mcp' || item.kind === 'http' || item.kind === 'builtin' || item.kind === 'manual' ? item.kind : 'manual',
    displayName: item.displayName.trim(),
    capabilities: Array.isArray(item.capabilities) ? item.capabilities.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()) : [],
    config: item.config && typeof item.config === 'object' ? sanitizeStringRecord(item.config) : {},
    enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
  }]
}

function normalizeWorkflowStep(value: unknown): DesktopRoutine['workflow'] {
  if (!value || typeof value !== 'object') return []
  const item = value as Partial<DesktopRoutine['workflow'][number]>
  if (typeof item.id !== 'string' || !item.id.trim()) return []
  if (typeof item.title !== 'string' || !item.title.trim()) return []
  const kind = item.kind === 'connector_fetch' || item.kind === 'agent_prompt' || item.kind === 'subagent_review' || item.kind === 'audience_eval' || item.kind === 'approval_gate'
    ? item.kind
    : 'agent_prompt'
  return [{
    id: item.id.trim(),
    kind,
    title: item.title.trim(),
    prompt: typeof item.prompt === 'string' ? item.prompt.trim() : '',
    connectorIds: Array.isArray(item.connectorIds) ? item.connectorIds.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()) : [],
    config: item.config && typeof item.config === 'object' ? sanitizeWorkflowConfig(item.config) : {},
  }]
}

function sanitizeStringRecord(value: object): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (typeof entry !== 'string') return []
    return [[key, entry]]
  }))
}

function sanitizeWorkflowConfig(value: object): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') return []
    return [[key, entry]]
  }))
}

function formatConnectorConfig(config: Record<string, string>): string {
  const entries = Object.entries(config)
  if (entries.length === 0) return '(none)'
  return entries.map(([key, value]) => {
    const masked = /token|secret|password|key/i.test(key) ? '[set]' : value
    return `${key}=${masked}`
  }).join(', ')
}

function formatWorkflowConfig(config: Record<string, string | number | boolean>): string {
  const entries = Object.entries(config)
  if (entries.length === 0) return '(none)'
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(', ')
}

async function resolveRoutineWorkspace(workspaceRoot: string | undefined): Promise<string> {
  const resolved = workspaceRoot ? resolve(workspaceRoot) : AGENT_ROOT
  if (!await isDirectory(resolved)) throw new Error(`Routine workspace does not exist: ${resolved}`)
  return resolved
}

function createRoutineId(): string {
  const stamp = Date.now().toString(36)
  const suffix = Math.random().toString(36).slice(2, 8)
  return `routine-${stamp}-${suffix}`
}

function createRoutineRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const suffix = Math.random().toString(36).slice(2, 8)
  return `routine-run-${stamp}-${suffix}`
}

function parseScheduleText(scheduleText: string) {
  const normalized = scheduleText.trim().toLowerCase()
  const daily = /daily(?:\s+at)?\s+(\d{1,2}:\d{2})/.exec(normalized)
  const dailyTime = daily?.[1]
  if (dailyTime) return { kind: 'daily' as const, time: normalizeTime(dailyTime), timezone: 'local' }
  if (normalized.includes('daily')) return { kind: 'daily' as const, time: '09:00', timezone: 'local' }
  return defaultRoutineSchedule()
}

function normalizeTime(value: string): string {
  const [hour = '9', minute = '00'] = value.split(':')
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}

async function ensureAgentRootProject(): Promise<void> {
  const current = await readProjectsFile()
  if (current.some(project => project.path === AGENT_ROOT)) return
  await mkdir(DATA_HOME, { recursive: true })
  await writeFile(
    PROJECTS_FILE,
    JSON.stringify([...current, projectFromPath(AGENT_ROOT, 'agentRoot')].slice(0, 50), null, 2) + '\n',
    'utf8',
  )
}

async function registeredChangelogProject(url: URL): Promise<string> {
  const requested = url.searchParams.get('workspaceRoot')?.trim()
  if (!requested) throw new Error('workspaceRoot is required')
  const resolved = resolve(requested)
  const projects = await listProjects()
  if (!projects.some(project => project.path === resolved)) {
    throw new Error('Project is not registered with JesseAgent.')
  }
  return resolved
}

async function readProjectsFile(): Promise<DesktopProject[]> {
  try {
    const raw = await readFile(PROJECTS_FILE, 'utf8')
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap(item => normalizeProject(item))
  } catch {
    return []
  }
}

function normalizeProject(value: unknown): DesktopProject[] {
  if (!value || typeof value !== 'object') return []
  const item = value as Partial<DesktopProject>
  if (typeof item.path !== 'string' || !item.path.trim()) return []
  const resolved = resolve(item.path)
  return [{
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : basename(resolved),
    path: resolved,
    lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : '',
    source: item.source === 'agentRoot' || item.source === 'selected' ? item.source : 'manual',
  }]
}

function projectFromPath(projectPath: string, source: DesktopProject['source']): DesktopProject {
  const resolved = resolve(projectPath)
  return {
    name: basename(resolved) || resolved,
    path: resolved,
    lastUsedAt: new Date().toISOString(),
    source,
  }
}

async function isDirectory(pathname: string): Promise<boolean> {
  try {
    return (await stat(pathname)).isDirectory()
  } catch {
    return false
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw) as unknown
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function contentType(filePath: string): string {
  const extension = extname(filePath)
  if (extension === '.html') return 'text/html; charset=utf-8'
  if (extension === '.js') return 'text/javascript; charset=utf-8'
  if (extension === '.css') return 'text/css; charset=utf-8'
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.png') return 'image/png'
  return 'application/octet-stream'
}

function normalizePort(value: string | undefined): number {
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535) return parsed
  return DEFAULT_PORT
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

main().catch(error => {
  stderr.write(`desktop server fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
