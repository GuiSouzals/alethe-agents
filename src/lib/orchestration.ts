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
  /**
   * Lord: honestidade da verificação de escopo (manutenção pós-ADR-0013,
   * item 2). Código estável (`sem_terminal_origem`,
   * `terminal_origem_desconhecido`) quando o `/spawn` aceitou o pedido SEM
   * poder verificar o provider contra a allowlist do terminal de origem.
   * `undefined` = verificado. Nunca implica bloqueio — a decisão de aceitar
   * já foi tomada no Rust; isto só evita que a tela pareça ter conferido
   * algo que não conferiu.
   */
  scopeNote?: string
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
  /** Lord: ver `OrchestrationEvent.scopeNote` — mesma semântica, persistida no run. */
  scopeNote?: string
  /**
   * Lord: `eventId` de todo evento que formou este run, em ordem de aplicação.
   * Existe só para a poda: quando o teto de retenção descarta o run, estas são
   * exatamente as chaves que precisam sair de `seenEventIds`, senão o mapa de
   * dedupe continuaria crescendo sem fim e a poda seria pela metade. Opcional
   * porque fixtures montam run à mão; o reducer sempre preenche.
   */
  eventIds?: string[]
}

// Lord: fonte única do rótulo de cada estado. Havia uma cópia local no componente de
// atividade; um segundo consumidor (o painel global) faria as duas divergirem.
export const ORCHESTRATION_STATUS_KEYS = {
  requested: 'orchestration.state.requested',
  accepted: 'orchestration.state.accepted',
  terminal_created: 'orchestration.state.terminalCreated',
  pty_started: 'orchestration.state.running',
  tool_started: 'orchestration.state.toolRunning',
  tool_finished: 'orchestration.state.toolFinished',
  process_exited: 'orchestration.state.ended',
  failed: 'orchestration.state.failed',
  revoked: 'orchestration.state.revoked',
} as const

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

// Lord: estado terminal é o que não tem nenhuma transição de saída na tabela
// acima. Derivar daqui em vez de repetir a lista à mão evita que um estado novo
// em `ORCHESTRATION_TRANSITIONS` fique de fora sem ninguém perceber.
// ADR-0008: "encerrado" descreve o PROCESSO ter terminado, nunca aprovação.
export function isOrchestrationRunFinished(status: OrchestrationEventType): boolean {
  return ORCHESTRATION_TRANSITIONS[status].length === 0
}

/**
 * Lord: teto de retenção da projeção. O reducer só fazia append: `runOrder`,
 * `runsById` (com `finalTranscript` inteiro dentro) e `seenEventIds` cresciam
 * enquanto o app estivesse aberto. O teto é alto de propósito — quem consulta
 * histórico usa a aba "Agentes" — e existe para o crescimento ser limitado, não
 * para esconder run recente.
 */
export const MAX_ORCHESTRATION_RUNS = 200

// Lord: descarte FIFO da run mais antiga quando passa do teto. Leva junto as
// chaves de dedupe daquela run, porque poda que esquece `seenEventIds` continua
// vazando memória. Pura: monta cópias e nunca muta a projeção recebida.
function pruneOrchestrationProjection(
  projection: OrchestrationProjection,
): OrchestrationProjection {
  if (projection.runOrder.length <= MAX_ORCHESTRATION_RUNS) return projection

  const runOrder = [...projection.runOrder]
  const runsById = { ...projection.runsById }
  const seenEventIds = { ...projection.seenEventIds }
  while (runOrder.length > MAX_ORCHESTRATION_RUNS) {
    const oldestRunId = runOrder.shift()
    if (oldestRunId === undefined) break
    const dropped = runsById[oldestRunId]
    delete runsById[oldestRunId]
    for (const eventId of dropped?.eventIds ?? []) delete seenEventIds[eventId]
  }
  return { runsById, runOrder, seenEventIds }
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
    scopeNote: base.scopeNote ?? event.scopeNote,
    // Lord: rastro dos eventos desta run, consumido só pela poda (ver
    // `pruneOrchestrationProjection`).
    eventIds: [...(current?.eventIds ?? []), event.eventId],
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

  return pruneOrchestrationProjection({
    runsById: { ...projection.runsById, [event.runId]: next },
    runOrder: current ? projection.runOrder : [...projection.runOrder, event.runId],
    seenEventIds: { ...projection.seenEventIds, [event.eventId]: true },
  })
}

// Lord F3: A ligação persistida é mínima; todo o restante do run permanece efêmero.
export function findRunForSubTab(
  projection: Pick<OrchestrationProjection, 'runsById'>,
  tab: SubTab | undefined,
): OrchestrationRun | undefined {
  if (!tab?.orchestrationJobId) return undefined
  return Object.values(projection.runsById).find((run) => run.jobId === tab.orchestrationJobId)
}
