import assert from 'node:assert/strict'
import test from 'node:test'
import { hasOutputsRailContent } from '../src/components/OutputsRail.tsx'

test('outputs rail stays hidden when it only has automatic conversation context', () => {
  assert.equal(hasOutputsRailContent({
    files: [],
    commands: [],
    sources: [{ id: 'chat', kind: 'Chat', label: 'Chat' }],
  }), false)
  assert.equal(hasOutputsRailContent({
    files: [],
    commands: [],
    sources: [{ id: 'project:/workspace', kind: 'Project', label: 'workspace' }],
  }), false)
})

test('outputs rail appears when it has an output or a meaningful source', () => {
  assert.equal(hasOutputsRailContent({
    files: [{ path: 'result.png', action: 'created' }],
    commands: [],
    sources: [{ id: 'chat', kind: 'Chat', label: 'Chat' }],
  }), true)
  assert.equal(hasOutputsRailContent({
    files: [],
    commands: [],
    sources: [{ id: 'selection:1', kind: 'Selection', label: 'Selected text' }],
  }), true)
})
