/**
 * planMode.ts - simplified Claude Code-style plan approval workflow.
 *
 * Current scope:
 * - keep one plan file per session in .jesse/plans
 * - let exit_plan_mode save a final plan and ask the user to approve it
 * - approved plans switch from plan -> acceptEdits
 * - rejected plans keep the agent in plan mode
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { confirmYesNo } from './confirm.js'
import { getPermissionMode, setPermissionMode } from './permissionMode.js'
import type { PlanModeEventInput } from './session.js'

const PLAN_DIR = '.jesse/plans'

let currentSessionId: string | null = null
let recordPlanModeEvent: ((event: PlanModeEventInput) => Promise<void>) | null = null

export interface PlanModeContext {
  planDir: string
  planFilePath: string | null
  hasSession: boolean
  isPlanMode: boolean
}

export interface ExitPlanModeResult {
  approved: boolean
  planFilePath: string
  plan: string
  nextMode: 'plan' | 'acceptEdits'
}

export function initializePlanModeSession(
  sessionId: string,
  recorder?: (event: PlanModeEventInput) => Promise<void>,
): void {
  currentSessionId = sessionId
  recordPlanModeEvent = recorder ?? null
}

export function getPlanModeContext(): PlanModeContext {
  return {
    planDir: PLAN_DIR,
    planFilePath: currentSessionId ? getPlanFilePath() : null,
    hasSession: currentSessionId !== null,
    isPlanMode: getPermissionMode() === 'plan',
  }
}

export async function exitPlanModeWithApproval(plan: string): Promise<ExitPlanModeResult> {
  const normalizedPlan = plan.trim()
  if (!normalizedPlan) throw new Error('plan 不能为空。')
  if (getPermissionMode() !== 'plan') {
    throw new Error('exit_plan_mode 只能在 Plan 模式中调用。请先使用 /plan 进入计划模式。')
  }

  const planFilePath = getPlanFilePath()
  await savePlan(normalizedPlan)
  await appendPlanEvent({ action: 'submitted', filePath: planFilePath, plan: normalizedPlan })

  const approved = await confirmYesNo(
    [
      '📋 Plan ready for approval.',
      `Plan file: ${planFilePath}`,
      '',
      normalizedPlan,
      '',
      '批准这个计划并切换到 Accept Edits 模式开始执行吗？',
    ].join('\n'),
  )

  if (!approved) {
    await appendPlanEvent({
      action: 'rejected',
      filePath: planFilePath,
      plan: normalizedPlan,
      nextMode: 'plan',
    })
    return { approved: false, planFilePath, plan: normalizedPlan, nextMode: 'plan' }
  }

  const result = setPermissionMode('acceptEdits')
  if (!result.ok) throw new Error(result.reason)
  await appendPlanEvent({
    action: 'approved',
    filePath: planFilePath,
    plan: normalizedPlan,
    nextMode: 'acceptEdits',
  })
  return { approved: true, planFilePath, plan: normalizedPlan, nextMode: 'acceptEdits' }
}

export async function savePlan(plan: string): Promise<string> {
  const planFilePath = getPlanFilePath()
  await mkdir(PLAN_DIR, { recursive: true })
  await writeFile(planFilePath, `${plan.trim()}\n`, 'utf8')
  return planFilePath
}

export async function readCurrentPlan(): Promise<string | null> {
  if (!currentSessionId) return null
  try {
    return await readFile(getPlanFilePath(), 'utf8')
  } catch {
    return null
  }
}

function getPlanFilePath(): string {
  if (!currentSessionId) {
    throw new Error('Plan Mode 尚未绑定 session。')
  }
  return join(PLAN_DIR, `${sanitizeSessionId(currentSessionId)}.md`)
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

async function appendPlanEvent(event: PlanModeEventInput): Promise<void> {
  if (!recordPlanModeEvent) return
  await recordPlanModeEvent(event)
}
