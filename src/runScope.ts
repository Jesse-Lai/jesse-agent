export interface RunScopeMismatch {
  ok: false
  code: 'approval_run_mismatch' | 'run_not_active'
}

export interface RunScopeMatch {
  ok: true
}

export type RunScopeValidation = RunScopeMatch | RunScopeMismatch

/** Legacy clients may omit runId during the compatibility window. */
export function validateApprovalRun(
  pendingRunId: string | undefined,
  requestedRunId: string | undefined,
): RunScopeValidation {
  if (!requestedRunId || pendingRunId === requestedRunId) return { ok: true }
  return { ok: false, code: 'approval_run_mismatch' }
}

/** A scoped cancel is valid only while that exact run remains active. */
export function validateCancelRun(
  activeRunId: string | undefined,
  requestedRunId: string | undefined,
): RunScopeValidation {
  if (!requestedRunId || activeRunId === requestedRunId) return { ok: true }
  return { ok: false, code: 'run_not_active' }
}
