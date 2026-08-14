import type { AgentType, OrchestrationPresentation, SubTab } from './types'

// Lord F3: Gates explícitos mantêm team/animated indisponíveis nesta entrega.
export const TEAM_ORCHESTRATION_ENABLED = false
export const ANIMATED_ORCHESTRATION_ENABLED = false

// Lord F3: A preferência fica pronta sem permitir que animated substitua o PTY nesta entrega.
export function effectiveOrchestrationPresentation(
  preference: OrchestrationPresentation,
): OrchestrationPresentation {
  return preference === 'animated' && ANIMATED_ORCHESTRATION_ENABLED ? 'animated' : 'dev'
}

export type OrchestrationEventType =
  | 'requested'
  | 'accepted'
  | 'terminal_created'
  | 'pty_started'
  | 'tool_started'
  | 'tool_finished'
  | 'process_exited'
  | 'failed'
  | 'revoked'

export type OrchestrationRunSource = 'external_spawn' | 'internal_subagent'
export type OrchestrationLiveOutput = 'pty' | 'unavailable'

export type OrchestrationEvent = {
  eventId: string
  type: OrchestrationEventType
  runId: string
  requestId: string
  jobId: string
  provider: AgentType
  origin: string
  source: OrchestrationRunSource
  occurredAt: number
  parentRunId?: string
  parentTerminalId?: string
  terminalId?: string
  tabId?: string
  ptyId?: string
  internalAgentId?: string
  toolCallId?: string
  toolName?: string
  exitCode?: number | null
  failureReason?: string
  finalTranscript?: string
  liveOutput: OrchestrationLiveOutput
}

export type OrchestrationRun = {
  runId: string
  requestId: string
  jobId: string
  provider: AgentType
  origin: string
  source: OrchestrationRunSource
  status: OrchestrationEventType
  requestedAt: number
  updatedAt: number
  parentRunId?: string
  parentTerminalId?: string
  terminalId?: string
  tabId?: string
  ptyId?: string
  internalAgentId?: string
  activeToolCallId?: string
  lastToolName?: string
  exitCode?: number | null
  failureReason?: string
  finalTranscript?: string
  liveOutput: OrchestrationLiveOutput
}

export type OrchestrationProjection = {
  runsById: Record<string, OrchestrationRun>
  runOrder: string[]
  seenEventIds: Record<string, true>
}

export const EMPTY_ORCHESTRATION_PROJECTION: OrchestrationProjection = {
  runsById: {},
  runOrder: [],
  seenEventIds: {},
}

// Lord F3: Tabela fechada; saltos para a frente são aceitos, regressões e terminais são rejeitados.
export const ORCHESTRATION_TRANSITIONS: Record<
  OrchestrationEventType,
  readonly OrchestrationEventType[]
> = {
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

export function canApplyOrchestrationTransition(
  current: OrchestrationEventType,
  next: OrchestrationEventType,
): boolean {
  return ORCHESTRATION_TRANSITIONS[current].includes(next)
}

function hasIdentityConflict(run: OrchestrationRun, event: OrchestrationEvent): boolean {
  return (
    run.requestId !== event.requestId ||
    run.jobId !== event.jobId ||
    run.provider !== event.provider ||
    Boolean(run.terminalId && event.terminalId && run.terminalId !== event.terminalId) ||
    Boolean(run.ptyId && event.ptyId && run.ptyId !== event.ptyId)
  )
}

// Lord F3: Reducer puro projeta processo, nunca qualidade, aprovação ou sucesso de conteúdo.
export function reduceOrchestrationProjection(
  projection: OrchestrationProjection,
  event: OrchestrationEvent,
): OrchestrationProjection {
  if (projection.seenEventIds[event.eventId]) return projection

  const current = projection.runsById[event.runId]
  if (
    current &&
    (hasIdentityConflict(current, event) ||
      !canApplyOrchestrationTransition(current.status, event.type))
  ) {
    return projection
  }

  const base: OrchestrationRun = current ?? {
    runId: event.runId,
    requestId: event.requestId,
    jobId: event.jobId,
    provider: event.provider,
    origin: event.origin,
    source: event.source,
    status: event.type,
    requestedAt: event.occurredAt,
    updatedAt: event.occurredAt,
    liveOutput: event.liveOutput,
  }

  const next: OrchestrationRun = {
    ...base,
    status: event.type,
    updatedAt: Math.max(base.updatedAt, event.occurredAt),
    parentRunId: base.parentRunId ?? event.parentRunId,
    parentTerminalId: base.parentTerminalId ?? event.parentTerminalId,
    terminalId: base.terminalId ?? event.terminalId,
    tabId: base.tabId ?? event.tabId,
    ptyId: base.ptyId ?? event.ptyId,
    internalAgentId: base.internalAgentId ?? event.internalAgentId,
    liveOutput: event.liveOutput,
  }

  if (event.type === 'tool_started') {
    next.activeToolCallId = event.toolCallId
    next.lastToolName = event.toolName
  } else if (event.type === 'tool_finished') {
    next.activeToolCallId = undefined
    next.lastToolName = event.toolName ?? base.lastToolName
  } else if (event.type === 'process_exited') {
    next.exitCode = event.exitCode
    if (event.finalTranscript) next.finalTranscript = event.finalTranscript
  } else if (event.type === 'failed') {
    next.failureReason = event.failureReason
  }

  return {
    runsById: { ...projection.runsById, [event.runId]: next },
    runOrder: current ? projection.runOrder : [...projection.runOrder, event.runId],
    seenEventIds: { ...projection.seenEventIds, [event.eventId]: true },
  }
}

// Lord F3: A ligação persistida é mínima; todo o restante do run permanece efêmero.
export function findRunForSubTab(
  projection: Pick<OrchestrationProjection, 'runsById'>,
  tab: SubTab | undefined,
): OrchestrationRun | undefined {
  if (!tab?.orchestrationJobId) return undefined
  return Object.values(projection.runsById).find((run) => run.jobId === tab.orchestrationJobId)
}
