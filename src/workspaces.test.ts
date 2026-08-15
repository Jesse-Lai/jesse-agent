import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createScratchWorkspace,
  managedWorkspaceRoots,
  normalizeProjectName,
  promoteScratchWorkspace,
} from './workspaces.js'

test('scratch workspaces are isolated and can be promoted without changing identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jesse-workspace-home-'))
  const sessionId = '20260809T080829Z-rnj1wz'

  try {
    const roots = managedWorkspaceRoots(home)
    const scratch = await createScratchWorkspace(sessionId, home)
    assert.equal(scratch.id, sessionId)
    assert.equal(scratch.kind, 'scratch')
    assert.equal(scratch.path, join(roots.scratch, sessionId))

    const artifact = join(scratch.path, 'index.html')
    await writeFile(artifact, '<h1>demo</h1>', 'utf8')

    const promoted = await promoteScratchWorkspace(scratch, 'DeepSeek Logo Demo', home)
    assert.equal(promoted.id, sessionId)
    assert.equal(promoted.kind, 'project')
    assert.equal(promoted.path, join(roots.projects, 'DeepSeek Logo Demo'))
    assert.equal(await readFile(join(promoted.path, 'index.html'), 'utf8'), '<h1>demo</h1>')
    await assert.rejects(stat(scratch.path))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('project promotion sanitizes names and avoids collisions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jesse-workspace-collision-'))

  try {
    assert.equal(normalizeProjectName('  Demo / unsafe:name  '), 'Demo - unsafe-name')
    const first = await createScratchWorkspace('session-one', home)
    const second = await createScratchWorkspace('session-two', home)
    const firstProject = await promoteScratchWorkspace(first, 'Demo', home)
    const secondProject = await promoteScratchWorkspace(second, 'Demo', home)
    assert.equal(firstProject.displayName, 'Demo')
    assert.equal(secondProject.displayName, 'Demo-2')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
