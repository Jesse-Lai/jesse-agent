import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, it } from 'node:test'
import {
  DEFAULT_CHANGELOG_ILLUSTRATION_STYLE,
  buildIllustrationPrompt,
  buildNarrativePrompt,
  clearChangelogRunActive,
  finalizeDueChangelogs,
  listDailyChangelogs,
  markChangelogRunActive,
  readDailyChangelog,
  recordChangelogRun,
  type ChangelogNarrative,
  type ChangelogRunEvidence,
} from './changelog.js'

const roots: string[] = []
const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6WQAAAABJRU5ErkJggg=='

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('daily project changelog', () => {
  it('keeps the documented default illustration style identical to the runtime default', async () => {
    const example = JSON.parse(await readFile(new URL('../changelog-config.example.json', import.meta.url), 'utf8')) as { illustrationStylePrompt?: string }
    assert.equal(example.illustrationStylePrompt, DEFAULT_CHANGELOG_ILLUSTRATION_STYLE)
  })

  it('waits until the whole local day has ended before generating once', async () => {
    const root = await temporaryProject()
    await recordChangelogRun(root, evidence(root, 'run-1', '2026-08-09T03:00:00.000Z'), { timezone: 'Asia/Shanghai' })
    await recordChangelogRun(root, evidence(root, 'run-2', '2026-08-09T12:00:00.000Z'), { timezone: 'Asia/Shanghai' })

    let narrativeCalls = 0
    let illustrationCalls = 0
    const dependencies = {
      config: { timezone: 'Asia/Shanghai', finalizeAt: '00:05' },
      createNarrative: async () => { narrativeCalls += 1; return narrative() },
      createIllustration: async () => { illustrationCalls += 1; return { dataURL: ONE_PIXEL_PNG } },
    }

    const beforeCutoff = await finalizeDueChangelogs(root, {
      ...dependencies,
      now: new Date('2026-08-09T16:03:00.000Z'),
    })
    assert.deepEqual(beforeCutoff, [])
    assert.equal(narrativeCalls, 0)
    assert.equal(illustrationCalls, 0)

    const afterCutoff = await finalizeDueChangelogs(root, {
      ...dependencies,
      now: new Date('2026-08-09T16:06:00.000Z'),
    })
    assert.deepEqual(afterCutoff, ['2026-08-09'])
    assert.equal(narrativeCalls, 1)
    assert.equal(illustrationCalls, 1)

    await finalizeDueChangelogs(root, {
      ...dependencies,
      now: new Date('2026-08-09T18:00:00.000Z'),
    })
    assert.equal(narrativeCalls, 1)
    assert.equal(illustrationCalls, 1)

    const raw = JSON.parse(await readFile(join(root, '.jesse', 'changelogs', '2026-08-09.json'), 'utf8')) as { runs?: unknown[] }
    assert.equal(raw.runs?.length, 2)
  })

  it('uses the project-configured timezone while collecting evidence', async () => {
    const root = await temporaryProject()
    await mkdir(join(root, '.jesse'), { recursive: true })
    await writeFile(join(root, '.jesse', 'changelog-config.json'), JSON.stringify({
      timezone: 'Asia/Shanghai',
      finalizeAt: '00:05',
    }), 'utf8')

    await recordChangelogRun(root, evidence(root, 'configured-timezone', '2026-08-09T16:30:00.000Z'))

    const stored = await readdir(join(root, '.jesse', 'changelogs'))
    assert.ok(stored.includes('2026-08-10.json'))
    assert.ok(!stored.includes('2026-08-09.json'))
  })

  it('keeps every run when several runs finish concurrently', async () => {
    const root = await temporaryProject()
    await Promise.all(Array.from({ length: 12 }, (_, index) => recordChangelogRun(
      root,
      evidence(root, `concurrent-${index}`, '2026-08-09T08:00:00.000Z'),
      { timezone: 'UTC' },
    )))

    const raw = JSON.parse(await readFile(join(root, '.jesse', 'changelogs', '2026-08-09.json'), 'utf8')) as { runs?: unknown[] }
    assert.equal(raw.runs?.length, 12)
  })

  it('allows concurrent midnight sweeps to create only one illustration', async () => {
    const root = await temporaryProject()
    await recordChangelogRun(root, evidence(root, 'one-day', '2026-08-09T08:00:00.000Z'), { timezone: 'UTC' })
    let narrativeCalls = 0
    let illustrationCalls = 0
    const options = {
      now: new Date('2026-08-10T00:10:00.000Z'),
      config: { timezone: 'UTC', finalizeAt: '00:05' },
      createNarrative: async () => { narrativeCalls += 1; return narrative() },
      createIllustration: async () => { illustrationCalls += 1; return { dataURL: ONE_PIXEL_PNG } },
    }

    await Promise.all(Array.from({ length: 6 }, () => finalizeDueChangelogs(root, options)))

    assert.equal(narrativeCalls, 1)
    assert.equal(illustrationCalls, 1)
  })

  it('defers a day while a cross-midnight run is active', async () => {
    const root = await temporaryProject()
    await recordChangelogRun(root, evidence(root, 'completed-run', '2026-08-09T10:00:00.000Z'), { timezone: 'Asia/Shanghai' })
    await markChangelogRunActive(root, 'cross-midnight', '2026-08-09T15:55:00.000Z')

    let calls = 0
    const options = {
      now: new Date('2026-08-09T16:10:00.000Z'),
      config: { timezone: 'Asia/Shanghai', finalizeAt: '00:05' },
      createNarrative: async () => { calls += 1; return narrative() },
      createIllustration: async () => ({ dataURL: ONE_PIXEL_PNG }),
    }
    assert.deepEqual(await finalizeDueChangelogs(root, options), [])
    assert.equal(calls, 0)

    await clearChangelogRunActive(root, 'cross-midnight')
    assert.deepEqual(await finalizeDueChangelogs(root, options), ['2026-08-09'])
    assert.equal(calls, 1)
  })

  it('splits a cross-midnight run by each file change timestamp', async () => {
    const root = await temporaryProject()
    const crossMidnight = evidence(root, 'cross-midnight-evidence', '2026-08-09T15:59:00.000Z')
    crossMidnight.finishedAt = '2026-08-09T16:02:00.000Z'
    crossMidnight.fileChanges.push({
      path: join(root, 'src', 'after-midnight.ts'),
      action: 'created',
      changedAt: '2026-08-09T16:01:00.000Z',
    })

    assert.deepEqual(
      await recordChangelogRun(root, crossMidnight, { timezone: 'Asia/Shanghai' }),
      ['2026-08-09', '2026-08-10'],
    )
    const before = JSON.parse(await readFile(join(root, '.jesse', 'changelogs', '2026-08-09.json'), 'utf8')) as { runs: Array<{ fileChanges: Array<{ path: string }> }> }
    const after = JSON.parse(await readFile(join(root, '.jesse', 'changelogs', '2026-08-10.json'), 'utf8')) as { runs: Array<{ fileChanges: Array<{ path: string }> }> }
    assert.deepEqual(before.runs[0]?.fileChanges.map(change => change.path), ['src/feature.ts'])
    assert.deepEqual(after.runs[0]?.fileChanges.map(change => change.path), ['src/after-midnight.ts'])
  })

  it('keeps the style prompt replaceable while requiring a concrete scene', async () => {
    const root = await temporaryProject()
    await mkdir(join(root, '.jesse'), { recursive: true })
    await writeFile(join(root, '.jesse', 'changelog-config.json'), JSON.stringify({
      timezone: 'Asia/Shanghai',
      finalizeAt: '00:05',
      illustrationStylePrompt: 'CUSTOM PAPER CUT STYLE',
    }), 'utf8')
    await recordChangelogRun(root, evidence(root, 'run-style', '2026-08-09T08:00:00.000Z'), { timezone: 'Asia/Shanghai' })

    let prompt = ''
    await finalizeDueChangelogs(root, {
      now: new Date('2026-08-09T16:10:00.000Z'),
      createNarrative: async () => narrative(),
      createIllustration: async value => { prompt = value; return { dataURL: ONE_PIXEL_PNG } },
    })

    assert.match(prompt, /CUSTOM PAPER CUT STYLE/)
    assert.match(prompt, /Central subject: two friendly bridge builders/)
    assert.match(prompt, /Visible action: carrying two matching puzzle pieces/)
    assert.doesNotMatch(prompt, /src\/feature\.ts/)

    const builtIn = buildIllustrationPrompt({
      date: '2026-08-09',
      projectName: 'JesseAgent',
      narrative: narrative(),
    }, DEFAULT_CHANGELOG_ILLUSTRATION_STYLE)
    assert.match(builtIn, /hand-drawn wax crayon and oil pastel/)
    assert.match(builtIn, /source code/)
    assert.doesNotMatch(builtIn, /JesseAgent/)
    assert.doesNotMatch(builtIn, /2026-08-09/)
  })

  it('does not send a filename from an unsafe scene to the image service', async () => {
    const root = await temporaryProject()
    await recordChangelogRun(root, evidence(root, 'unsafe-scene', '2026-08-09T08:00:00.000Z'), { timezone: 'UTC' })
    const unsafe = narrative()
    unsafe.scene.centralSubject = 'the src/feature.ts file'
    let imageCalls = 0

    assert.deepEqual(await finalizeDueChangelogs(root, {
      now: new Date('2026-08-10T00:10:00.000Z'),
      config: { timezone: 'UTC', finalizeAt: '00:05' },
      createNarrative: async () => unsafe,
      createIllustration: async () => { imageCalls += 1; return { dataURL: ONE_PIXEL_PNG } },
    }), [])
    assert.equal(imageCalls, 0)
  })

  it('publishes plain-language details and returns at most five recent cards', async () => {
    const root = await temporaryProject()
    for (let day = 1; day <= 6; day += 1) {
      const date = `2026-08-${String(day).padStart(2, '0')}T08:00:00.000Z`
      await recordChangelogRun(root, evidence(root, `run-${day}`, date), { timezone: 'UTC' })
    }
    await finalizeDueChangelogs(root, {
      now: new Date('2026-08-09T12:00:00.000Z'),
      config: { timezone: 'UTC', finalizeAt: '00:05' },
      createNarrative: async () => narrative(),
      createIllustration: async () => ({ dataURL: ONE_PIXEL_PNG }),
    })

    const cards = await listDailyChangelogs(root, 5)
    assert.equal(cards.length, 5)
    assert.equal(cards[0]?.date, '2026-08-06')
    assert.equal(cards[4]?.date, '2026-08-02')

    const detail = await readDailyChangelog(root, '2026-08-06')
    assert.equal(detail?.headline, '让每天的工作更容易回顾')
    assert.equal(detail?.highlights.length, 3)
    assert.deepEqual(detail?.changedFiles, ['src/feature.ts'])
    assert.deepEqual(detail?.sourceSessions, ['session-run-6'])
  })

  it('refreshes late text evidence without creating a second illustration', async () => {
    const root = await temporaryProject()
    await recordChangelogRun(root, evidence(root, 'first', '2026-08-09T08:00:00.000Z'), { timezone: 'UTC' })
    let narrativeCalls = 0
    let illustrationCalls = 0
    const options = {
      now: new Date('2026-08-10T00:10:00.000Z'),
      config: { timezone: 'UTC', finalizeAt: '00:05' },
      createNarrative: async () => { narrativeCalls += 1; return narrative() },
      createIllustration: async () => { illustrationCalls += 1; return { dataURL: ONE_PIXEL_PNG } },
    }
    await finalizeDueChangelogs(root, options)

    await recordChangelogRun(root, evidence(root, 'late', '2026-08-09T12:00:00.000Z'), { timezone: 'UTC' })
    await finalizeDueChangelogs(root, options)

    assert.equal(narrativeCalls, 2)
    assert.equal(illustrationCalls, 1)
    const raw = JSON.parse(await readFile(join(root, '.jesse', 'changelogs', '2026-08-09.json'), 'utf8')) as { runs?: unknown[] }
    assert.equal(raw.runs?.length, 2)
  })

  it('keeps the written changelog available while a failed illustration retries', async () => {
    const root = await temporaryProject()
    await recordChangelogRun(root, evidence(root, 'retry-image', '2026-08-09T08:00:00.000Z'), { timezone: 'UTC' })
    let narrativeCalls = 0
    let illustrationCalls = 0
    const options = {
      now: new Date('2026-08-10T00:10:00.000Z'),
      config: { timezone: 'UTC', finalizeAt: '00:05' },
      createNarrative: async () => { narrativeCalls += 1; return narrative() },
      createIllustration: async () => {
        illustrationCalls += 1
        if (illustrationCalls === 1) throw new Error('temporary image outage')
        return { dataURL: ONE_PIXEL_PNG }
      },
    }

    await finalizeDueChangelogs(root, options)
    const failedCard = (await listDailyChangelogs(root, 5))[0]
    assert.equal(failedCard?.illustrationStatus, 'failed')
    assert.equal(failedCard?.imageAvailable, false)
    assert.equal(failedCard?.headline, narrative().headline)

    await finalizeDueChangelogs(root, options)
    const recoveredCard = (await listDailyChangelogs(root, 5))[0]
    assert.equal(recoveredCard?.illustrationStatus, 'ready')
    assert.equal(recoveredCard?.imageAvailable, true)
    assert.equal(narrativeCalls, 1)
    assert.equal(illustrationCalls, 2)
  })

  it('does not create a day for a completed run without real project changes', async () => {
    const root = await temporaryProject()
    const noChanges = evidence(root, 'run-empty', '2026-08-09T08:00:00.000Z')
    noChanges.fileChanges = []
    noChanges.git = { changed: false, changedPaths: [] }
    assert.deepEqual(await recordChangelogRun(root, noChanges, { timezone: 'UTC' }), [])
    assert.deepEqual(await listDailyChangelogs(root), [])
  })

  it('ignores cache and generated build files', async () => {
    const root = await temporaryProject()
    const generatedOnly = evidence(root, 'run-generated', '2026-08-09T08:00:00.000Z')
    generatedOnly.fileChanges = [
      { path: join(root, 'dist', 'bundle.js'), action: 'created', changedAt: generatedOnly.finishedAt },
      { path: join(root, 'node_modules', 'package', 'index.js'), action: 'updated', changedAt: generatedOnly.finishedAt },
    ]
    generatedOnly.git = { changed: false, changedPaths: [] }

    assert.deepEqual(await recordChangelogRun(root, generatedOnly, { timezone: 'UTC' }), [])
    assert.deepEqual(await listDailyChangelogs(root), [])
  })

  it('asks the editor for human language instead of engineering taxonomy', async () => {
    const root = await temporaryProject()
    await recordChangelogRun(root, evidence(root, 'run-prompt', '2026-08-09T08:00:00.000Z'), { timezone: 'UTC' })
    const raw = JSON.parse(await readFile(join(root, '.jesse', 'changelogs', '2026-08-09.json'), 'utf8')) as Parameters<typeof buildNarrativePrompt>[0]
    const prompt = buildNarrativePrompt(raw)
    assert.match(prompt, /conversational Simplified Chinese/)
    assert.match(prompt, /what changed and why it matters/)
    assert.match(prompt, /Do not use Feature\/Fix\/Refactor/)
    assert.match(prompt, /one-to-one visual mapping/)
    assert.match(prompt, /never put a project, person, or company name/)
  })
})

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jesse-changelog-'))
  roots.push(root)
  return root
}

function evidence(root: string, runId: string, changedAt: string): ChangelogRunEvidence {
  return {
    runId,
    sessionId: `session-${runId}`,
    startedAt: changedAt,
    finishedAt: changedAt,
    userRequest: '让项目可以自动整理每天完成的工作。',
    assistantResult: '已经接入每日记录，并完成类型检查。',
    fileChanges: [{ path: join(root, 'src', 'feature.ts'), action: 'edited', changedAt }],
    verifications: [{ label: 'npm run typecheck', ok: true, finishedAt: changedAt }],
    git: { changed: true, changedPaths: ['src/feature.ts'] },
  }
}

function narrative(): ChangelogNarrative {
  return {
    headline: '让每天的工作更容易回顾',
    summary: 'JesseAgent 现在会在一天结束后，把当天真正完成的变化整理成容易理解的记录。',
    highlights: [
      { title: '集中整理一天的成果', detail: '等当天工作全部结束后再总结，因此内容不会只反映第一项修改。' },
      { title: '只记录真实变化', detail: '纯问答和失败任务不会混进项目记录。' },
      { title: '保留验证结果', detail: '详情会说明当天的修改经过了哪些检查。' },
    ],
    verification: ['类型检查已通过。'],
    scene: {
      centralSubject: 'two friendly bridge builders',
      action: 'carrying two matching puzzle pieces toward the center of a small bridge',
      setting: 'a quiet riverside workshop at sunset',
      supportingObjects: ['a neatly rolled plan', 'a small toolbox'],
      composition: 'the bridge and matching pieces form one clear focal point in the center',
      mood: 'calm, capable, and warmly collaborative',
    },
  }
}
