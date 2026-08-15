import assert from 'node:assert/strict'
import test from 'node:test'
import { validateApprovalRun, validateCancelRun } from './runScope.js'

test('approval rejects a runId that does not own the pending request', () => {
  assert.deepEqual(validateApprovalRun('run-active', 'run-stale'), {
    ok: false,
    code: 'approval_run_mismatch',
  })
  assert.deepEqual(validateApprovalRun('run-active', 'run-active'), { ok: true })
  assert.deepEqual(validateApprovalRun('run-active', undefined), { ok: true })
})

test('cancel rejects a stale or missing active runId without stopping another run', () => {
  assert.deepEqual(validateCancelRun('run-active', 'run-stale'), {
    ok: false,
    code: 'run_not_active',
  })
  assert.deepEqual(validateCancelRun(undefined, 'run-finished'), {
    ok: false,
    code: 'run_not_active',
  })
  assert.deepEqual(validateCancelRun('run-active', 'run-active'), { ok: true })
  assert.deepEqual(validateCancelRun('run-active', undefined), { ok: true })
})
