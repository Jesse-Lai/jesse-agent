import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { legacyAgentRootCandidates, prepareProductDataHome, readProductMigration } from './productData.js'

test('product data migration copies legacy state once without deleting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jesse-product-data-'))
  const legacy = join(root, 'agent', '.jesse')
  const dataHome = join(root, 'app-data')
  await mkdir(join(legacy, 'chat'), { recursive: true })
  await writeFile(join(legacy, 'desktop-projects.json'), '[{"name":"Legacy"}]\n')
  await writeFile(join(legacy, 'chat', 'session.jsonl'), 'legacy\n')
  await writeFile(join(root, 'agent', '.env'), 'LLM_API_MODE=copilot_sdk\n')

  await prepareProductDataHome(join(root, 'agent'), dataHome)
  await writeFile(join(dataHome, 'desktop-projects.json'), '[{"name":"Current"}]\n')
  await prepareProductDataHome(join(root, 'agent'), dataHome)

  assert.match(await readFile(join(dataHome, 'desktop-projects.json'), 'utf8'), /Current/)
  assert.match(await readFile(join(legacy, 'desktop-projects.json'), 'utf8'), /Legacy/)
  assert.match(await readFile(join(dataHome, '.env'), 'utf8'), /copilot_sdk/)
  assert.equal((await readProductMigration(dataHome))?.version, 1)
})

test('packaged migration can discover the legacy personal checkout without embedding an absolute path', () => {
  const candidates = legacyAgentRootCandidates('/Applications/Jesse Agent.app/Contents/Resources/AgentService', {}, '/Users/tester')
  assert.ok(candidates.includes('/Users/tester/Desktop/JesseAgent/jesse-agent'))
  assert.ok(candidates.includes('/Users/tester/Projects/JesseAgent/jesse-agent'))
  assert.equal(candidates.every(candidate => candidate.startsWith('/Applications/') || candidate.startsWith('/Users/tester/')), true)
})
