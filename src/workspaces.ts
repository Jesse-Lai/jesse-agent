import { rename, mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

export type SessionWorkspaceKind = 'scratch' | 'project' | 'existing'

export interface SessionWorkspaceMetadata {
  /** Stable identity. The path may change when a scratch workspace is promoted. */
  id: string
  kind: SessionWorkspaceKind
  path: string
  displayName: string
}

export interface ManagedWorkspaceRoots {
  home: string
  scratch: string
  projects: string
}

export function managedWorkspaceRoots(homeOverride?: string): ManagedWorkspaceRoots {
  const configured = homeOverride?.trim() || process.env.JESSE_WORKSPACE_HOME?.trim()
  const home = resolve(configured || join(homedir(), 'JesseAgent'))
  return {
    home,
    scratch: join(home, 'Scratch'),
    projects: join(home, 'Projects'),
  }
}

export async function createScratchWorkspace(
  sessionId: string,
  homeOverride?: string,
): Promise<SessionWorkspaceMetadata> {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(sessionId)) {
    throw new Error(`Invalid session id for scratch workspace: ${sessionId}`)
  }

  const roots = managedWorkspaceRoots(homeOverride)
  const path = join(roots.scratch, sessionId)
  await mkdir(path, { recursive: true })
  return {
    id: sessionId,
    kind: 'scratch',
    path,
    displayName: 'Temporary workspace',
  }
}

export async function promoteScratchWorkspace(
  workspace: SessionWorkspaceMetadata,
  requestedName: string,
  homeOverride?: string,
): Promise<SessionWorkspaceMetadata> {
  if (workspace.kind !== 'scratch') throw new Error('Only a temporary workspace can be saved as a project.')

  const roots = managedWorkspaceRoots(homeOverride)
  const source = await realpath(workspace.path)
  const scratchRoot = await realpath(roots.scratch)
  if (!isWithin(scratchRoot, source) || source === scratchRoot) {
    throw new Error('The workspace is not inside JesseAgent Scratch.')
  }

  const displayName = normalizeProjectName(requestedName)
  await mkdir(roots.projects, { recursive: true })
  const destination = await availableProjectPath(roots.projects, displayName)
  await rename(source, destination)

  return {
    ...workspace,
    kind: 'project',
    path: destination,
    displayName: basename(destination),
  }
}

export function normalizeProjectName(input: string): string {
  const normalized = input
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/:\\]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 80)
    .trim()
  if (!normalized) throw new Error('Project name is required.')
  return normalized
}

async function availableProjectPath(projectsRoot: string, displayName: string): Promise<string> {
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const name = suffix === 1 ? displayName : `${displayName}-${suffix}`
    const candidate = join(projectsRoot, name)
    if (!await pathExists(candidate)) return candidate
  }
  throw new Error(`Could not find an available project folder for ${displayName}.`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
