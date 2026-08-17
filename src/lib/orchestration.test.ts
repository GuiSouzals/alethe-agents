import { describe, expect, it } from 'vitest'

import {
  EMPTY_ORCHESTRATION_PROJECTION,
  effectiveOrchestrationPresentation,
  reduceOrchestrationProjection,
  TEAM_ORCHESTRATION_ENABLED,
  type OrchestrationEvent,
  type OrchestrationEventType,
  type OrchestrationProjection,
  type OrchestrationRun,
} from './orchestration'

const EVENT_TYPES: OrchestrationEventType[] = [
  'requested',
  'accepted',
  'terminal_created',
  'pty_started',
  'tool_started',
  'tool_finished',
  'process_exited',
  'failed',
  'revoked',
]

// Lord F3: Tabela esperada independente da implementação do reducer.
const EXPECTED: Record<OrchestrationEventType, readonly OrchestrationEventType[]> = {
  requested: [
    'accepted',
    'terminal_created',
    'pty_started',
    'tool_started',
    'tool_finished',
    'process_exited',
    'failed',
    'revoked',
  ],
  accepted: [
    'terminal_created',
    'pty_started',
    'tool_started',
    'tool_finished',
    'process_exited',
    'failed',
    'revoked',
  ],
  terminal_created: [
    'pty_started',
    'tool_started',
    'tool_finished',
    'process_exited',
    'failed',
    'revoked',
  ],
  pty_started: ['tool_started', 'tool_finished', 'process_exited', 'failed', 'revoked'],
  tool_started: ['tool_finished', 'process_exited', 'failed', 'revoked'],
  tool_finished: ['tool_started', 'process_exited', 'failed', 'revoked'],
  process_exited: [],
  failed: [],
  revoked: [],
}

function event(type: OrchestrationEventType, suffix = type): OrchestrationEvent {
  return {
    eventId: `event-${suffix}`,
    type,
    runId: 'run-1',
    requestId: 'request-1',
    jobId: 'job-1',
    provider: 'codex',
    origin: 'lord',
    source: 'external_spawn',
    occurredAt: 10,
    parentTerminalId: 'parent-1',
    terminalId: type === 'requested' || type === 'accepted' ? undefined : 'child-1',
    ptyId: ['pty_started', 'tool_started', 'tool_finished', 'process_exited'].includes(type)
      ? 'pty-1'
      : undefined,
    toolCallId: type.startsWith('tool_') ? `tool-${suffix}` : undefined,
    toolName: type.startsWith('tool_') ? 'shell' : undefined,
    exitCode: type === 'process_exited' ? 0 : undefined,
    liveOutput: 'pty',
  }
}

function projectionAt(status: OrchestrationEventType): OrchestrationProjection {
  const run: OrchestrationRun = {
    runId: 'run-1',
    requestId: 'request-1',
    jobId: 'job-1',
    provider: 'codex',
    origin: 'lord',
    source: 'external_spawn',
    status,
    requestedAt: 1,
    updatedAt: 1,
    parentTerminalId: 'parent-1',
    terminalId: ['requested', 'accepted'].includes(status) ? undefined : 'child-1',
    ptyId: ['pty_started', 'tool_started', 'tool_finished', 'process_exited'].includes(status)
      ? 'pty-1'
      : undefined,
    liveOutput: 'pty',
  }
  return { runsById: { 'run-1': run }, runOrder: ['run-1'], seenEventIds: {} }
}

describe('Lord F3 orchestration reducer', () => {
  it('covers the complete transition table', () => {
    for (const current of EVENT_TYPES) {
      for (const next of EVENT_TYPES) {
        const before = projectionAt(current)
        const after = reduceOrchestrationProjection(before, event(next, `${current}-${next}`))
        const shouldAdvance = EXPECTED[current].includes(next)
        expect(after.runsById['run-1'].status, `${current} -> ${next}`).toBe(
          shouldAdvance ? next : current,
        )
        if (!shouldAdvance) expect(after).toBe(before)
      }
    }
  })

  it('ignores a duplicated event id', () => {
    const first = reduceOrchestrationProjection(EMPTY_ORCHESTRATION_PROJECTION, event('requested'))
    expect(reduceOrchestrationProjection(first, event('requested'))).toBe(first)
  })

  it('rejects an out-of-order regression', () => {
    const started = projectionAt('pty_started')
    expect(reduceOrchestrationProjection(started, event('accepted'))).toBe(started)
  })

  it('records process exit without interpreting content success', () => {
    const exited = reduceOrchestrationProjection(
      projectionAt('pty_started'),
      event('process_exited'),
    )
    const serialized = JSON.stringify(exited.runsById['run-1'])

    expect(exited.runsById['run-1'].status).toBe('process_exited')
    expect(serialized).not.toMatch(/approved|approval|success/i)
  })

  it('keeps the team capability feature gate closed', () => {
    expect(TEAM_ORCHESTRATION_ENABLED).toBe(false)
  })

  it('keeps dev effective while animated is only prepared', () => {
    expect(effectiveOrchestrationPresentation('dev')).toBe('dev')
    expect(effectiveOrchestrationPresentation('animated')).toBe('dev')
  })

  // Lord: honestidade da verificação de escopo (manutenção pós-ADR-0013, item
  // 2) — o run precisa reter o `scopeNote` do primeiro evento que o carregou,
  // do mesmo jeito que já faz com `parentTerminalId`.
  it('persists scopeNote from the requested event onto the run', () => {
    const requested = event('requested')
    const withNote = { ...requested, scopeNote: 'sem_terminal_origem' }
    const after = reduceOrchestrationProjection(EMPTY_ORCHESTRATION_PROJECTION, withNote)
    expect(after.runsById['run-1'].scopeNote).toBe('sem_terminal_origem')
  })

  it('leaves scopeNote undefined when the backend verified the scope', () => {
    const after = reduceOrchestrationProjection(EMPTY_ORCHESTRATION_PROJECTION, event('requested'))
    expect(after.runsById['run-1'].scopeNote).toBeUndefined()
  })
})
