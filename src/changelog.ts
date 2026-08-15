import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { generateImage, streamLLM, type Message } from './llm.js'
import type { RuntimeCommandResult, RuntimeFileChange } from './runtimeContext.js'

const execFileAsync = promisify(execFile)
const CHANGELOG_SCHEMA_VERSION = 1
const CHANGELOG_DIR = join('.jesse', 'changelogs')
const ACTIVE_RUN_DIR = '.active'
const RECORD_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const CHANGELOG_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.jesse',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
])
const CHANGELOG_GIT_PATHS = [
  '.',
  ':(exclude).jesse/**',
  ...[...CHANGELOG_IGNORED_DIRECTORIES]
    .filter(directory => directory !== '.jesse' && directory !== '.git')
    .map(directory => `:(glob,exclude)**/${directory}/**`),
]
const FINALIZATION_LOCK_STALE_MS = 15 * 60 * 1_000
const RECORD_LOCK_WAIT_MS = 60_000
const LOCK_RETRY_MS = 40
const MAX_GENERATION_ATTEMPTS = 3

export const DEFAULT_CHANGELOG_ILLUSTRATION_STYLE = 'Style: hand-drawn wax crayon and oil pastel illustration, made on textured paper with visible grain. Rough color strokes, layered colors, uneven pressure. No clean outlines, no sharp edges, no digital smoothness. Use warm, slightly saturated colors. Flat and simple shapes. No realistic lighting or shading. The overall feeling should be calm, friendly, and human, like a children’s picture book or editorial illustration. Avoid: digital illustration, clean line art, vector style, watercolor, oil painting, 3D render, realistic shading, smooth gradients, anime, cartoon style, ink outlines'

export interface ProjectChangeSnapshot {
  kind: 'git' | 'plain'
  fingerprint: string
  head?: string
  changedPaths: string[]
}

export interface ChangelogGitDelta {
  changed: boolean
  beforeHead?: string
  afterHead?: string
  changedPaths: string[]
}

export interface ChangelogRunEvidence {
  runId: string
  sessionId: string
  startedAt: string
  finishedAt: string
  userRequest: string
  assistantResult: string
  fileChanges: RuntimeFileChange[]
  verifications: RuntimeCommandResult[]
  git: ChangelogGitDelta
}

interface StoredRunEvidence {
  runId: string
  sessionId: string
  startedAt: string
  finishedAt: string
  userRequest: string
  assistantResult: string
  fileChanges: Array<{
    path: string
    action: RuntimeFileChange['action']
    changedAt: string
  }>
  verifications: Array<{
    label: string
    ok: boolean
    finishedAt: string
  }>
  git: ChangelogGitDelta
}

export interface ChangelogHighlight {
  title: string
  detail: string
}

export interface ChangelogSceneSpec {
  centralSubject: string
  action: string
  setting: string
  supportingObjects: string[]
  composition: string
  mood: string
}

export interface ChangelogNarrative {
  headline: string
  summary: string
  highlights: ChangelogHighlight[]
  verification: string[]
  scene: ChangelogSceneSpec
}

interface ChangelogIllustration {
  status: 'pending' | 'generating' | 'ready' | 'failed'
  fileName?: string
  generatedAt?: string
  prompt?: string
  stylePrompt?: string
  stylePromptHash?: string
  revisedPrompt?: string
  attemptCount: number
  lastAttemptAt?: string
  error?: string
}

interface DailyChangelogRecord {
  schemaVersion: number
  date: string
  timezone: string
  projectName: string
  status: 'collecting' | 'finalizing' | 'ready'
  createdAt: string
  updatedAt: string
  finalizedAt?: string
  runs: StoredRunEvidence[]
  narrative?: ChangelogNarrative
  illustration: ChangelogIllustration
  finalizationError?: string
}

export interface DailyChangelogSummary {
  date: string
  projectName: string
  headline: string
  summary: string
  highlightCount: number
  illustrationStatus: ChangelogIllustration['status']
  imageAvailable: boolean
  finalizedAt?: string
}

export interface DailyChangelogDetail extends DailyChangelogSummary {
  highlights: ChangelogHighlight[]
  verification: string[]
  changedFiles: string[]
  sourceSessions: string[]
}

export interface ChangelogConfig {
  timezone: string
  finalizeAt: string
  illustrationStylePrompt: string
}

export interface ChangelogFinalizeOptions {
  now?: Date
  configRoot?: string
  config?: Partial<ChangelogConfig>
  createNarrative?: (record: Readonly<DailyChangelogRecord>) => Promise<ChangelogNarrative>
  createIllustration?: (prompt: string) => Promise<{ dataURL: string; revisedPrompt?: string }>
}

interface ActiveRunMarker {
  runId: string
  projectRoot: string
  startedAt: string
  pid: number
}

const inProcessFinalizations = new Set<string>()

export async function captureProjectChangeSnapshot(projectRoot: string): Promise<ProjectChangeSnapshot> {
  const root = resolve(projectRoot)
  const head = await gitOutput(root, ['rev-parse', 'HEAD'])
  if (head === null) return { kind: 'plain', fingerprint: '', changedPaths: [] }

  const statusText = await gitOutput(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...CHANGELOG_GIT_PATHS,
  ]) ?? ''
  const diffText = await gitOutput(root, [
    'diff',
    '--binary',
    'HEAD',
    '--',
    ...CHANGELOG_GIT_PATHS,
  ]) ?? ''
  const fingerprint = createHash('sha256')
    .update(head)
    .update('\0')
    .update(statusText)
    .update('\0')
    .update(diffText)
    .digest('hex')

  return {
    kind: 'git',
    fingerprint,
    head: head.trim(),
    changedPaths: parseGitStatusPaths(statusText),
  }
}

export async function compareProjectChangeSnapshots(
  projectRoot: string,
  before: ProjectChangeSnapshot,
  after: ProjectChangeSnapshot,
): Promise<ChangelogGitDelta> {
  if (before.kind !== 'git' || after.kind !== 'git') {
    return { changed: false, changedPaths: [] }
  }

  const committedPaths = before.head && after.head && before.head !== after.head
    ? parseLineList(await gitOutput(resolve(projectRoot), [
        'diff',
        '--name-only',
        before.head,
        after.head,
        '--',
        ...CHANGELOG_GIT_PATHS,
      ]) ?? '')
    : []

  return {
    changed: before.fingerprint !== after.fingerprint,
    beforeHead: before.head,
    afterHead: after.head,
    changedPaths: uniqueStrings([...after.changedPaths, ...committedPaths]),
  }
}

export async function markChangelogRunActive(
  projectRoot: string,
  runId: string,
  startedAt: string,
): Promise<void> {
  const marker: ActiveRunMarker = {
    runId,
    projectRoot: resolve(projectRoot),
    startedAt,
    pid: process.pid,
  }
  const directory = activeRunDirectory(projectRoot)
  await mkdir(directory, { recursive: true })
  await writeJsonAtomic(join(directory, `${safeIdentifier(runId)}.json`), marker)
}

export async function clearChangelogRunActive(projectRoot: string, runId: string): Promise<void> {
  try {
    await unlink(join(activeRunDirectory(projectRoot), `${safeIdentifier(runId)}.json`))
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
}

export async function recordChangelogRun(
  projectRoot: string,
  evidence: ChangelogRunEvidence,
  options: { timezone?: string; now?: Date; configRoot?: string } = {},
): Promise<string[]> {
  const root = resolve(projectRoot)
  const config = await loadChangelogConfig(root, options.configRoot, {
    ...(validTimezone(options.timezone) ? { timezone: options.timezone } : {}),
  })
  const timezone = config.timezone
  const meaningfulFileChanges = evidence.fileChanges.filter(change => isProjectContentPath(root, change.path))
  if (meaningfulFileChanges.length === 0 && !evidence.git.changed) return []

  const gitDate = dateKey(new Date(evidence.finishedAt), timezone)
  const dates = uniqueStrings([
    ...meaningfulFileChanges.map(change => dateKey(new Date(change.changedAt), timezone)),
    ...(evidence.git.changed ? [gitDate] : []),
  ])
  const touchedDates: string[] = []

  for (const date of dates) {
    const recorded = await withChangelogLock(root, date, RECORD_LOCK_WAIT_MS, async () => {
      const now = (options.now ?? new Date()).toISOString()
      const existing = await readStoredRecord(root, date)
      const record = existing ?? createCollectingRecord(root, date, timezone, now)
      if (record.runs.some(run => run.runId === evidence.runId)) return false

      const changesForDate = meaningfulFileChanges
        .filter(change => dateKey(new Date(change.changedAt), timezone) === date)
        .map(change => ({
          path: projectRelativePath(root, change.path),
          action: change.action,
          changedAt: change.changedAt,
        }))
      const gitForDate: ChangelogGitDelta = date === gitDate && evidence.git.changed
        ? {
            ...evidence.git,
            changedPaths: evidence.git.changedPaths.map(path => projectRelativePath(root, path)),
          }
        : {
            changed: false,
            beforeHead: evidence.git.beforeHead,
            afterHead: evidence.git.afterHead,
            changedPaths: [],
          }
      const stored: StoredRunEvidence = {
        runId: evidence.runId,
        sessionId: evidence.sessionId,
        startedAt: evidence.startedAt,
        finishedAt: evidence.finishedAt,
        userRequest: trimEvidenceText(evidence.userRequest, 4_000),
        assistantResult: trimEvidenceText(evidence.assistantResult, 6_000),
        fileChanges: changesForDate,
        verifications: evidence.verifications.map(result => ({
          label: trimEvidenceText(result.label, 240),
          ok: result.ok,
          finishedAt: result.finishedAt,
        })),
        git: gitForDate,
      }

      record.runs.push(stored)
      record.updatedAt = now
      record.finalizationError = undefined
      if (record.status !== 'collecting') {
        // A very late piece of evidence should refresh the words, but never
        // create a second illustration for the same calendar day.
        record.status = 'collecting'
        record.narrative = undefined
        record.finalizedAt = undefined
      }
      await writeStoredRecord(root, record)
      return true
    })
    if (recorded) touchedDates.push(date)
  }

  return touchedDates
}

export async function finalizeDueChangelogs(
  projectRoot: string,
  options: ChangelogFinalizeOptions = {},
): Promise<string[]> {
  const root = resolve(projectRoot)
  const config = await loadChangelogConfig(root, options.configRoot, options.config)
  const now = options.now ?? new Date()
  const records = await readAllStoredRecords(root)
  const finalized: string[] = []

  for (const record of records.sort((a, b) => a.date.localeCompare(b.date))) {
    if (!isRecordDue(record, now, config)) continue
    if (await activeRunBlocksDate(root, record.date, record.timezone)) continue

    const key = `${root}\0${record.date}`
    if (inProcessFinalizations.has(key)) continue
    inProcessFinalizations.add(key)
    try {
      const changed = await withFinalizationLock(root, record.date, async () => {
        const latest = await readStoredRecord(root, record.date)
        if (!latest || !isRecordDue(latest, now, config)) return false
        if (await activeRunBlocksDate(root, latest.date, latest.timezone)) return false
        if (latest.status === 'ready' && latest.illustration.status === 'ready') return false

        if (latest.status === 'ready' && latest.narrative) {
          await generateAndPersistIllustration(root, latest, config, options, now)
          return true
        }

        latest.status = 'finalizing'
        latest.updatedAt = now.toISOString()
        latest.finalizationError = undefined
        await writeStoredRecord(root, latest)

        try {
          const narrative = normalizeNarrative(await (options.createNarrative
            ? options.createNarrative(latest)
            : createNarrativeWithLLM(latest)))
          assertIllustrationSceneIsSafe(latest, narrative)
          latest.narrative = narrative
          latest.status = 'ready'
          latest.finalizedAt = now.toISOString()
          latest.updatedAt = now.toISOString()
          latest.finalizationError = undefined
          await writeStoredRecord(root, latest)
        } catch (error) {
          latest.status = 'collecting'
          latest.updatedAt = now.toISOString()
          latest.finalizationError = errorMessage(error)
          await writeStoredRecord(root, latest)
          return false
        }

        await generateAndPersistIllustration(root, latest, config, options, now)
        return true
      })
      if (changed) finalized.push(record.date)
    } finally {
      inProcessFinalizations.delete(key)
    }
  }

  return finalized
}

export async function listDailyChangelogs(
  projectRoot: string,
  limit = 5,
): Promise<DailyChangelogSummary[]> {
  const records = await readAllStoredRecords(projectRoot)
  return records
    .filter(record => record.status === 'ready' && record.narrative)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, Math.max(1, Math.min(50, Math.floor(limit))))
    .map(toSummary)
}

export async function readDailyChangelog(
  projectRoot: string,
  date: string,
): Promise<DailyChangelogDetail | null> {
  if (!DATE_PATTERN.test(date)) return null
  const record = await readStoredRecord(projectRoot, date)
  if (!record || record.status !== 'ready' || !record.narrative) return null
  return {
    ...toSummary(record),
    highlights: record.narrative.highlights,
    verification: record.narrative.verification,
    changedFiles: changedFilesForRecord(record),
    sourceSessions: uniqueStrings(record.runs.map(run => run.sessionId)),
  }
}

export async function dailyChangelogImagePath(projectRoot: string, date: string): Promise<string | null> {
  if (!DATE_PATTERN.test(date)) return null
  const record = await readStoredRecord(projectRoot, date)
  if (!record || record.illustration.status !== 'ready' || !record.illustration.fileName) return null
  const filePath = join(changelogDirectory(projectRoot), basename(record.illustration.fileName))
  try {
    return (await stat(filePath)).isFile() ? filePath : null
  } catch {
    return null
  }
}

export function buildIllustrationPrompt(
  record: Pick<DailyChangelogRecord, 'date' | 'projectName'> & { narrative: ChangelogNarrative },
  stylePrompt: string,
): string {
  const scene = record.narrative.scene
  return [
    'Create one editorial illustration that makes this completed day of project work immediately understandable.',
    'Do not render a date or any other text.',
    '',
    `Central subject: ${scene.centralSubject}`,
    `Visible action: ${scene.action}`,
    `Setting: ${scene.setting}`,
    `Supporting objects: ${scene.supportingObjects.join(', ') || 'none'}`,
    `Composition: ${scene.composition}`,
    `Mood: ${scene.mood}`,
    '',
    'Turn the software change into a concrete physical scene with a clear subject doing a clear action. The main object must represent what changed, the action must represent how it changed, and the resulting state must show the practical benefit. The viewer should understand the core idea at a glance. Do not fall back to a generic person working, celebrating, holding tools, or checking a list unless that action directly represents the actual change. Use one main visual story and no more than two supporting symbols. Do not show or imply a project name, person name, company name, source code, terminal window, UI screenshot, file path, URL, secret, label, caption, watermark, logo, or readable text.',
    '',
    stylePrompt.trim(),
  ].join('\n')
}

export function buildNarrativePrompt(record: Readonly<DailyChangelogRecord>): string {
  const runs = record.runs.map(run => ({
    objective: run.userRequest,
    result: run.assistantResult,
    changedAreas: uniqueStrings([
      ...run.fileChanges.map(change => change.path),
      ...run.git.changedPaths,
    ]).slice(0, 30),
    verification: run.verifications,
  }))
  return [
    `Project: ${record.projectName}`,
    `Day: ${record.date}`,
    '',
    'Write a daily changelog for the person who will open this project tomorrow.',
    '- Use clear, conversational Simplified Chinese.',
    '- You may use the project\'s professional terms, but explain their practical meaning in plain language.',
    '- Each highlight must say what changed and why it matters in practice.',
    '- Do not expose tool names, commit hashes, internal prompts, or file paths unless a filename is essential to understanding the result.',
    '- Do not use Feature/Fix/Refactor/Docs/Tests as visible headings.',
    '- Keep only 1 to 7 meaningful highlights; never pad the list or claim work that the evidence does not prove.',
    '- Also convert the single most important change into one concrete, glanceable physical illustration scene. Prefer familiar real-world objects and an unmistakable action over generic metaphors. Specify a central subject, a visible action, a setting, at most two supporting objects, composition, and mood.',
    '- Build a one-to-one visual mapping: the main object represents the changed product behavior, its action represents the modification, and the visible result represents why the change matters to the user. A generic worker, celebration, toolbox, checklist, or pile of cards is not a sufficient scene by itself.',
    '- The scene is sent to a separate image service. It must be fully abstracted: never put a project, person, or company name, filename, path, URL, code identifier, secret, code, UI, or readable text in any scene field.',
    '',
    'Return JSON only with this exact shape:',
    '{"headline":"...","summary":"...","highlights":[{"title":"...","detail":"..."}],"verification":["..."],"scene":{"centralSubject":"...","action":"...","setting":"...","supportingObjects":["..."],"composition":"...","mood":"..."}}',
    '',
    `Evidence:\n${JSON.stringify(runs)}`,
  ].join('\n')
}

async function generateAndPersistIllustration(
  projectRoot: string,
  record: DailyChangelogRecord,
  config: ChangelogConfig,
  options: ChangelogFinalizeOptions,
  now: Date,
): Promise<void> {
  if (!record.narrative || record.illustration.status === 'ready') return
  if (record.illustration.attemptCount >= MAX_GENERATION_ATTEMPTS) return

  const prompt = buildIllustrationPrompt(
    { date: record.date, projectName: record.projectName, narrative: record.narrative },
    config.illustrationStylePrompt,
  )
  record.illustration = {
    ...record.illustration,
    status: 'generating',
    prompt,
    stylePrompt: config.illustrationStylePrompt,
    stylePromptHash: createHash('sha256').update(config.illustrationStylePrompt).digest('hex'),
    attemptCount: record.illustration.attemptCount + 1,
    lastAttemptAt: now.toISOString(),
    error: undefined,
  }
  record.updatedAt = now.toISOString()
  await writeStoredRecord(projectRoot, record)

  try {
    const generated = await (options.createIllustration
      ? options.createIllustration(prompt)
      : generateImage({ prompt }))
    const image = decodePngDataURL(generated.dataURL)
    const fileName = `${record.date}.png`
    await writeBufferAtomic(join(changelogDirectory(projectRoot), fileName), image)
    record.illustration = {
      ...record.illustration,
      status: 'ready',
      fileName,
      generatedAt: now.toISOString(),
      revisedPrompt: generated.revisedPrompt,
      error: undefined,
    }
  } catch (error) {
    record.illustration = {
      ...record.illustration,
      status: 'failed',
      error: errorMessage(error),
    }
  }
  record.updatedAt = now.toISOString()
  await writeStoredRecord(projectRoot, record)
}

async function createNarrativeWithLLM(record: Readonly<DailyChangelogRecord>): Promise<ChangelogNarrative> {
  const messages: Message[] = [
    {
      role: 'system',
      content: 'You are an exacting product changelog editor and visual storyteller. Use only supplied evidence. Return valid JSON and no markdown.',
    },
    { role: 'user', content: buildNarrativePrompt(record) },
  ]
  let text = ''
  for await (const event of streamLLM(messages, { allowTools: false })) {
    if (event.type === 'text_delta') text += event.text
    if (event.type === 'done' && event.response.type === 'text' && !text) text = event.response.text
  }
  const json = extractJsonObject(text)
  return normalizeNarrative(JSON.parse(json) as unknown)
}

async function loadChangelogConfig(
  projectRoot: string,
  configRoot?: string,
  override: Partial<ChangelogConfig> = {},
): Promise<ChangelogConfig> {
  const defaults: ChangelogConfig = {
    timezone: localTimezone(),
    finalizeAt: '00:05',
    illustrationStylePrompt: DEFAULT_CHANGELOG_ILLUSTRATION_STYLE,
  }
  const roots = uniqueStrings([configRoot ? resolve(configRoot) : '', resolve(projectRoot)].filter(Boolean))
  let fileConfig: Partial<ChangelogConfig> = {}
  for (const root of roots) {
    try {
      const raw = JSON.parse(await readFile(join(root, '.jesse', 'changelog-config.json'), 'utf8')) as unknown
      if (raw && typeof raw === 'object') fileConfig = { ...fileConfig, ...normalizeConfig(raw) }
    } catch {
      // Missing or malformed optional config falls back to the built-in defaults.
    }
  }
  const merged = { ...defaults, ...fileConfig, ...override }
  return {
    timezone: validTimezone(merged.timezone) ? merged.timezone : defaults.timezone,
    finalizeAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(merged.finalizeAt) ? merged.finalizeAt : defaults.finalizeAt,
    illustrationStylePrompt: merged.illustrationStylePrompt.trim() || defaults.illustrationStylePrompt,
  }
}

function normalizeConfig(value: object): Partial<ChangelogConfig> {
  const config = value as Record<string, unknown>
  return {
    ...(typeof config.timezone === 'string' ? { timezone: config.timezone.trim() } : {}),
    ...(typeof config.finalizeAt === 'string' ? { finalizeAt: config.finalizeAt.trim() } : {}),
    ...(typeof config.illustrationStylePrompt === 'string'
      ? { illustrationStylePrompt: config.illustrationStylePrompt.trim() }
      : {}),
  }
}

function normalizeNarrative(value: unknown): ChangelogNarrative {
  if (!value || typeof value !== 'object') throw new Error('Changelog model returned an invalid object.')
  const item = value as Record<string, unknown>
  const highlights = Array.isArray(item.highlights)
    ? item.highlights.flatMap(value => {
        if (!value || typeof value !== 'object') return []
        const highlight = value as Record<string, unknown>
        const title = cleanString(highlight.title, 100)
        const detail = cleanString(highlight.detail, 500)
        return title && detail ? [{ title, detail }] : []
      }).slice(0, 7)
    : []
  if (highlights.length === 0) throw new Error('Changelog model returned no usable highlights.')

  const sceneValue = item.scene && typeof item.scene === 'object'
    ? item.scene as Record<string, unknown>
    : {}
  const scene: ChangelogSceneSpec = {
    centralSubject: requiredString(sceneValue.centralSubject, 'scene.centralSubject', 300),
    action: requiredString(sceneValue.action, 'scene.action', 400),
    setting: requiredString(sceneValue.setting, 'scene.setting', 300),
    supportingObjects: Array.isArray(sceneValue.supportingObjects)
      ? sceneValue.supportingObjects.map(value => cleanString(value, 160)).filter(Boolean).slice(0, 2)
      : [],
    composition: requiredString(sceneValue.composition, 'scene.composition', 300),
    mood: requiredString(sceneValue.mood, 'scene.mood', 200),
  }

  return {
    headline: requiredString(item.headline, 'headline', 120),
    summary: requiredString(item.summary, 'summary', 500),
    highlights,
    verification: Array.isArray(item.verification)
      ? item.verification.map(value => cleanString(value, 300)).filter(Boolean).slice(0, 6)
      : [],
    scene,
  }
}

function createCollectingRecord(
  projectRoot: string,
  date: string,
  timezone: string,
  now: string,
): DailyChangelogRecord {
  return {
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    date,
    timezone,
    projectName: basename(resolve(projectRoot)) || resolve(projectRoot),
    status: 'collecting',
    createdAt: now,
    updatedAt: now,
    runs: [],
    illustration: { status: 'pending', attemptCount: 0 },
  }
}

function toSummary(record: DailyChangelogRecord): DailyChangelogSummary {
  const narrative = record.narrative!
  return {
    date: record.date,
    projectName: record.projectName,
    headline: narrative.headline,
    summary: narrative.summary,
    highlightCount: narrative.highlights.length,
    illustrationStatus: record.illustration.status,
    imageAvailable: record.illustration.status === 'ready' && Boolean(record.illustration.fileName),
    finalizedAt: record.finalizedAt,
  }
}

function isRecordDue(record: DailyChangelogRecord, now: Date, config: ChangelogConfig): boolean {
  const today = dateKey(now, record.timezone || config.timezone)
  if (record.date >= today) return false
  if (record.status === 'ready' && record.illustration.status === 'ready') return false
  if (record.status === 'ready' && record.illustration.attemptCount >= MAX_GENERATION_ATTEMPTS) return false

  const yesterday = dateKey(new Date(now.getTime() - 24 * 60 * 60 * 1_000), record.timezone || config.timezone)
  if (record.date < yesterday) return true
  const [hour, minute] = config.finalizeAt.split(':').map(Number)
  const local = localClockParts(now, record.timezone || config.timezone)
  return local.hour * 60 + local.minute >= (hour ?? 0) * 60 + (minute ?? 5)
}

async function activeRunBlocksDate(projectRoot: string, date: string, timezone: string): Promise<boolean> {
  let files: string[]
  try {
    files = await readdir(activeRunDirectory(projectRoot))
  } catch {
    return false
  }

  for (const file of files.filter(file => file.endsWith('.json'))) {
    const filePath = join(activeRunDirectory(projectRoot), file)
    try {
      const marker = JSON.parse(await readFile(filePath, 'utf8')) as Partial<ActiveRunMarker>
      if (typeof marker.startedAt !== 'string' || typeof marker.pid !== 'number') continue
      if (!isProcessAlive(marker.pid)) {
        await unlink(filePath).catch(() => undefined)
        continue
      }
      if (dateKey(new Date(marker.startedAt), timezone) <= date) return true
    } catch {
      // Ignore a partially written or stale marker; marker writes are atomic.
    }
  }
  return false
}

async function withFinalizationLock<T>(
  projectRoot: string,
  date: string,
  action: () => Promise<T>,
): Promise<T | undefined> {
  return await withChangelogLock(projectRoot, date, 0, action)
}

/**
 * One small lock serializes appends and finalization for a project-day. The
 * active-run marker normally keeps these paths apart; the lock closes the last
 * race between two runs that finish at the same time or a second process that
 * is performing the midnight sweep.
 */
async function withChangelogLock<T>(
  projectRoot: string,
  date: string,
  waitMs: number,
  action: () => Promise<T>,
): Promise<T | undefined> {
  const lockPath = join(changelogDirectory(projectRoot), `${date}.lock`)
  await mkdir(changelogDirectory(projectRoot), { recursive: true })
  const handle = await acquireChangelogLock(lockPath, waitMs)
  if (!handle) {
    if (waitMs > 0) throw new Error(`Timed out waiting to update changelog ${date}.`)
    return undefined
  }

  try {
    await handle.writeFile(`${process.pid}\n`, 'utf8')
    return await action()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

async function acquireChangelogLock(lockPath: string, waitMs: number): Promise<FileHandle | null> {
  const deadline = Date.now() + Math.max(0, waitMs)
  while (true) {
    try {
      return await open(lockPath, 'wx')
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error
    }

    try {
      const info = await stat(lockPath)
      if (await changelogLockIsStale(lockPath, info.mtimeMs)) {
        await unlink(lockPath)
        continue
      }
    } catch (error) {
      if (isMissingFileError(error)) continue
      throw error
    }

    if (Date.now() >= deadline) return null
    await delay(Math.min(LOCK_RETRY_MS, Math.max(1, deadline - Date.now())))
  }
}

async function changelogLockIsStale(lockPath: string, modifiedAt: number): Promise<boolean> {
  if (Date.now() - modifiedAt <= FINALIZATION_LOCK_STALE_MS) return false
  try {
    const ownerPid = Number((await readFile(lockPath, 'utf8')).trim())
    return !Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !isProcessAlive(ownerPid)
  } catch (error) {
    if (isMissingFileError(error)) return true
    throw error
  }
}

async function readAllStoredRecords(projectRoot: string): Promise<DailyChangelogRecord[]> {
  let files: string[]
  try {
    files = await readdir(changelogDirectory(projectRoot))
  } catch {
    return []
  }
  const records = await Promise.all(files.filter(file => RECORD_PATTERN.test(file)).map(async file => {
    return await readStoredRecord(projectRoot, file.slice(0, -'.json'.length))
  }))
  return records.filter((record): record is DailyChangelogRecord => Boolean(record))
}

async function readStoredRecord(projectRoot: string, date: string): Promise<DailyChangelogRecord | null> {
  if (!DATE_PATTERN.test(date)) return null
  try {
    const value = JSON.parse(await readFile(recordPath(projectRoot, date), 'utf8')) as unknown
    return normalizeStoredRecord(value)
  } catch {
    return null
  }
}

function normalizeStoredRecord(value: unknown): DailyChangelogRecord | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<DailyChangelogRecord>
  if (typeof item.date !== 'string' || !DATE_PATTERN.test(item.date)) return null
  if (!Array.isArray(item.runs)) return null
  const now = new Date().toISOString()
  return {
    schemaVersion: typeof item.schemaVersion === 'number' ? item.schemaVersion : CHANGELOG_SCHEMA_VERSION,
    date: item.date,
    timezone: typeof item.timezone === 'string' && validTimezone(item.timezone) ? item.timezone : localTimezone(),
    projectName: typeof item.projectName === 'string' && item.projectName ? item.projectName : 'Project',
    status: item.status === 'finalizing' || item.status === 'ready' ? item.status : 'collecting',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
    finalizedAt: typeof item.finalizedAt === 'string' ? item.finalizedAt : undefined,
    runs: item.runs,
    narrative: item.narrative,
    illustration: item.illustration && typeof item.illustration === 'object'
      ? {
          ...item.illustration,
          status: item.illustration.status === 'generating' || item.illustration.status === 'ready' || item.illustration.status === 'failed'
            ? item.illustration.status
            : 'pending',
          attemptCount: typeof item.illustration.attemptCount === 'number' ? item.illustration.attemptCount : 0,
        }
      : { status: 'pending', attemptCount: 0 },
    finalizationError: typeof item.finalizationError === 'string' ? item.finalizationError : undefined,
  }
}

async function writeStoredRecord(projectRoot: string, record: DailyChangelogRecord): Promise<void> {
  await mkdir(changelogDirectory(projectRoot), { recursive: true })
  await writeJsonAtomic(recordPath(projectRoot, record.date), record)
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function writeBufferAtomic(path: string, value: Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, value)
  await rename(temporary, path)
}

async function gitOutput(projectRoot: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: projectRoot,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    })
    return stdout
  } catch {
    return null
  }
}

function parseGitStatusPaths(status: string): string[] {
  return uniqueStrings(status.split('\n').flatMap(line => {
    if (line.length < 4) return []
    const path = line.slice(3).trim().replace(/^"|"$/g, '')
    if (!path) return []
    const renameTarget = path.includes(' -> ') ? path.split(' -> ').pop() ?? path : path
    if (isIgnoredChangelogRelativePath(renameTarget)) return []
    return [renameTarget]
  }))
}

function parseLineList(value: string): string[] {
  return uniqueStrings(value.split('\n').map(line => line.trim()).filter(line => line && !isIgnoredChangelogRelativePath(line)))
}

function changelogDirectory(projectRoot: string): string {
  return join(resolve(projectRoot), CHANGELOG_DIR)
}

function activeRunDirectory(projectRoot: string): string {
  return join(changelogDirectory(projectRoot), ACTIVE_RUN_DIR)
}

function recordPath(projectRoot: string, date: string): string {
  return join(changelogDirectory(projectRoot), `${date}.json`)
}

function isProjectContentPath(projectRoot: string, path: string): boolean {
  const absolute = resolve(path)
  if (absolute !== projectRoot && !absolute.startsWith(`${projectRoot}${sep}`)) return false
  const projectPath = relative(projectRoot, absolute)
  return Boolean(projectPath) && !isIgnoredChangelogRelativePath(projectPath)
}

function isIgnoredChangelogRelativePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  return normalized.split('/').some(segment => CHANGELOG_IGNORED_DIRECTORIES.has(segment))
}

function projectRelativePath(projectRoot: string, path: string): string {
  const absolute = resolve(projectRoot, path)
  const result = relative(projectRoot, absolute)
  return result && !result.startsWith('..') ? result : basename(path)
}

function dateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function localClockParts(date: Date, timezone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return { hour: Number(values.hour ?? 0), minute: Number(values.minute ?? 0) }
}

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'run'
}

function trimEvidenceText(value: string, max: number): string {
  const normalized = value.replace(/\u0000/g, '').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`
}

function cleanString(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

function requiredString(value: unknown, field: string, max: number): string {
  const result = cleanString(value, max)
  if (!result) throw new Error(`Changelog model omitted ${field}.`)
  return result
}

function extractJsonObject(value: string): string {
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Changelog model did not return JSON.')
  return value.slice(start, end + 1)
}

function decodePngDataURL(value: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value)
  if (!match?.[1]) throw new Error('Illustration generator did not return a PNG data URL.')
  const buffer = Buffer.from(match[1], 'base64')
  if (buffer.length < 8 || buffer.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new Error('Illustration generator returned invalid PNG data.')
  }
  return buffer
}

function changedFilesForRecord(record: DailyChangelogRecord): string[] {
  return uniqueStrings(record.runs.flatMap(run => [
    ...run.fileChanges.map(change => change.path),
    ...run.git.changedPaths,
  ]))
    .map(path => path.replaceAll('\\', '/').trim())
    .filter(path => path && path !== '.jesse' && !path.startsWith('.jesse/'))
    .sort((a, b) => a.localeCompare(b))
}

function assertIllustrationSceneIsSafe(record: DailyChangelogRecord, narrative: ChangelogNarrative): void {
  const sceneText = [
    narrative.scene.centralSubject,
    narrative.scene.action,
    narrative.scene.setting,
    ...narrative.scene.supportingObjects,
    narrative.scene.composition,
    narrative.scene.mood,
  ].join(' ').toLocaleLowerCase('en-US')
  const evidenceTerms = uniqueStrings([
    record.projectName,
    ...changedFilesForRecord(record),
    ...changedFilesForRecord(record).map(path => basename(path)),
  ])
    .map(term => term.trim().toLocaleLowerCase('en-US'))
    .filter(term => term.length >= 4)

  if (evidenceTerms.some(term => sceneText.includes(term))) {
    throw new Error('Changelog illustration scene contains a project name or file reference.')
  }
  if (/(?:https?:\/\/|www\.|file:\/\/|(?:^|\s)(?:~\/|\.\.?\/|\/)[^\s]+|[a-z]:\\|`[^`]*`|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|py|swift|kt|java|go|rs|cs|cpp|h|html|css|md)\b)/i.test(sceneText)) {
    throw new Error('Changelog illustration scene contains code, a URL, or a file path.')
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
