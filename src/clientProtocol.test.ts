import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { assertClientProtocolFixture } from './clientProtocol.js'

test('shared client protocol fixture matches the TypeScript contract', async () => {
  const raw = await readFile(join(process.cwd(), 'contracts', 'client-protocol-v1.json'), 'utf8')
  const fixture: unknown = JSON.parse(raw)
  assertClientProtocolFixture(fixture)
  assert.equal(fixture.envelope.run.id, fixture.run.id)
  assert.equal(fixture.session.metadata?.origin, 'mac')
})
