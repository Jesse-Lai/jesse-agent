import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentRuntimeContext } from './runtimeContext.js'
import { resolveWritableToolPath } from './workingDirectory.js'

test('file mutations cannot escape the active workspace', async () => {
  const container = await mkdtemp(join(tmpdir(), 'jesse-workspace-boundary-'))
  const workspace = join(container, 'workspace')
  const outside = join(container, 'outside')

  try {
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ])
    await symlink(outside, join(workspace, 'escape-link'))
    const context = createAgentRuntimeContext({
      projectRoot: workspace,
      cwd: workspace,
      originalProjectRoot: workspace,
    })

    assert.equal(
      await resolveWritableToolPath('nested/demo.txt', context),
      join(await realpath(workspace), 'nested', 'demo.txt'),
    )
    await assert.rejects(resolveWritableToolPath('../outside/demo.txt', context), /只能写入当前 workspace/)
    await assert.rejects(resolveWritableToolPath(join(outside, 'demo.txt'), context), /只能写入当前 workspace/)
    await assert.rejects(resolveWritableToolPath('escape-link/demo.txt', context), /符号链接越出了当前 workspace/)
  } finally {
    await rm(container, { recursive: true, force: true })
  }
})
