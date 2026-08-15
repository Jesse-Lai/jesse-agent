import assert from 'node:assert/strict'
import test from 'node:test'
import { projectRowAction } from '../src/projectInteraction.ts'

test('clicking an inactive project selects it without toggling it closed', () => {
  assert.equal(projectRowAction('project', '/projects/one', '/projects/two'), 'select')
})

test('clicking a project from chat selects it even when it was last active', () => {
  assert.equal(projectRowAction('chat', '/projects/one', '/projects/one'), 'select')
})

test('clicking the active project toggles its expansion', () => {
  assert.equal(projectRowAction('project', '/projects/one', '/projects/one'), 'toggle')
})
