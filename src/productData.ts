import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const MIGRATION_VERSION = 1

export function productDataHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.JESSE_DATA_HOME?.trim()
  if (configured) return resolve(configured)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'JesseAgent')
  if (process.platform === 'win32') return join(environment.APPDATA || homedir(), 'JesseAgent')
  return join(environment.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'jesse-agent')
}

export async function prepareProductDataHome(agentRoot: string, dataHome: string): Promise<void> {
  await mkdir(dataHome, { recursive: true })
  const markerPath = join(dataHome, '.migration-v1.json')
  if (await exists(markerPath)) return

  const legacyAgentRoot = await resolveLegacyAgentRoot(agentRoot)
  const legacyRoot = join(legacyAgentRoot, '.jesse')
  const migrated: string[] = []
  for (const relativePath of [
    'chat',
    'desktop-projects.json',
    'desktop-routines.json',
    'desktop-routine-runs.json',
  ]) {
    const source = join(legacyRoot, relativePath)
    const destination = join(dataHome, relativePath)
    if (!await exists(source) || await exists(destination)) continue
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false })
    migrated.push(relativePath)
  }
  const legacyEnvironment = join(legacyAgentRoot, '.env')
  const productEnvironment = join(dataHome, '.env')
  if (await exists(legacyEnvironment) && !await exists(productEnvironment)) {
    await cp(legacyEnvironment, productEnvironment, { errorOnExist: true, force: false })
    migrated.push('.env')
  }

  await writeFile(markerPath, JSON.stringify({
    version: MIGRATION_VERSION,
    migratedAt: new Date().toISOString(),
    legacyRoot,
    migrated,
  }, null, 2) + '\n', 'utf8')
}

export function legacyAgentRootCandidates(
  agentRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const configured = environment.JESSE_LEGACY_AGENT_ROOT?.trim()
  const candidates = [
    agentRoot,
    ...(configured ? [resolve(configured)] : []),
    join(home, 'Desktop', 'JesseAgent', 'jesse-agent'),
    join(home, 'JesseAgent', 'jesse-agent'),
    join(home, 'Projects', 'JesseAgent', 'jesse-agent'),
    join(home, 'Developer', 'JesseAgent', 'jesse-agent'),
  ]
  return [...new Set(candidates.map(candidate => resolve(candidate)))]
}

async function resolveLegacyAgentRoot(agentRoot: string): Promise<string> {
  for (const candidate of legacyAgentRootCandidates(agentRoot)) {
    if (await hasLegacyProductData(candidate)) return candidate
  }
  return agentRoot
}

async function hasLegacyProductData(candidate: string): Promise<boolean> {
  if (await exists(join(candidate, '.env'))) return true
  const legacyRoot = join(candidate, '.jesse')
  return await exists(join(legacyRoot, 'desktop-projects.json'))
    || await exists(join(legacyRoot, 'chat'))
    || await exists(join(legacyRoot, 'desktop-routines.json'))
}

export async function readProductMigration(dataHome: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dataHome, '.migration-v1.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
