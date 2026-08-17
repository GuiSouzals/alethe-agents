import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import { getLocale, translate } from '../lib/i18n'
import { AGENT_TYPE_LABELS, type AgentType } from '../lib/types'
import { effectiveOrchestrationPresentation, type OrchestrationEvent } from '../lib/orchestration'
import { useOrchestrationStore } from '../stores/orchestrationStore'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import {
  resolveSpawnTarget,
  type AgentSpawnPayloadV1,
  type SpawnProject,
  type SpawnResolution,
} from './resolveSpawnTarget'

// Lord D1: Tipos estreitos para executar e confirmar o contrato sem lógica de julgamento.
type SpawnReport = {
  requestId: string
  status: 'terminal_created' | 'rejected'
  terminalId?: string
  reason?: string
}

type SpawnExecutorDependencies = {
  hydrated: boolean
  projects: readonly SpawnProject[]
  claim: (requestId: string) => Promise<boolean>
  report: (report: SpawnReport) => Promise<void>
  createTerminal: (
    decision: Extract<SpawnResolution, { status: 'matched' }>,
  ) => Promise<{ id: string }>
  focusTerminal: (projectId: string, terminalId: string) => void
  recordEvent?: (event: OrchestrationEvent) => void
  notifyDispatched?: (decision: Extract<SpawnResolution, { status: 'matched' }>) => void
  shouldFocusTerminal?: (decision: Extract<SpawnResolution, { status: 'matched' }>) => boolean
  onError?: (error: unknown) => void
}

type MatchedSpawn = Extract<SpawnResolution, { status: 'matched' }>

// Lord F3: Args preservam somente IDs/origem no SubTab; o prompt segue transitório até o xterm.
export function buildSpawnTerminalArgs(decision: MatchedSpawn) {
  return {
    name: decision.name?.trim() || AGENT_TYPE_LABELS[decision.provider],
    cwd: decision.cwd,
    firstTab: {
      type: decision.provider,
      cwd: decision.cwd,
      initialInput: decision.task,
      orchestrationMode: 'solo' as const,
      orchestrationOrigin: decision.origin,
      orchestrationRequestId: decision.requestId,
      orchestrationJobId: decision.jobId,
      orchestrationParentTerminalId: decision.parentTerminalId,
      // Lord ADR-0014 D3: pedido de captura, quando o /spawn o incluiu.
      transcriptCapture: decision.transcriptCapture,
    },
  }
}

// Lord F3: O adaptador só declara fatos observados no protocolo real.
function spawnProjectionEvent(
  decision: MatchedSpawn,
  type: OrchestrationEvent['type'],
  details: Pick<OrchestrationEvent, 'terminalId' | 'tabId' | 'failureReason'> = {},
): OrchestrationEvent {
  return {
    eventId: `${decision.jobId}:${type}`,
    type,
    runId: decision.jobId,
    requestId: decision.requestId,
    jobId: decision.jobId,
    provider: decision.provider,
    origin: decision.origin,
    source: 'external_spawn',
    occurredAt: Date.now(),
    parentTerminalId: decision.parentTerminalId,
    // Lord: honestidade da verificação de escopo (manutenção pós-ADR-0013,
    // item 2) — presente quando o `/spawn` não pôde checar o provider contra
    // a allowlist real do terminal de origem (ver `agent_events.rs`).
    scopeNote: decision.scopeNote,
    liveOutput: 'pty',
    ...details,
  }
}

// Lord D1: O executor aplica a decisão pura e confirma somente resultados realmente observados.
export async function executeAgentSpawn(
  payload: AgentSpawnPayloadV1,
  dependencies: SpawnExecutorDependencies,
): Promise<void> {
  const decision = resolveSpawnTarget(payload, dependencies.projects, dependencies.hydrated)
  if (decision.status !== 'matched') {
    await dependencies.report({
      requestId: payload.requestId,
      status: 'rejected',
      reason: decision.reason,
    })
    return
  }

  dependencies.recordEvent?.(spawnProjectionEvent(decision, 'requested'))

  if (!(await dependencies.claim(payload.requestId))) return
  dependencies.recordEvent?.(spawnProjectionEvent(decision, 'accepted'))

  let terminal: { id: string }
  try {
    terminal = await dependencies.createTerminal(decision)
  } catch (error) {
    dependencies.onError?.(error)
    dependencies.recordEvent?.(
      spawnProjectionEvent(decision, 'failed', { failureReason: 'terminal_creation_failed' }),
    )
    await dependencies.report({
      requestId: payload.requestId,
      status: 'rejected',
      reason: 'terminal_creation_failed',
    })
    return
  }

  dependencies.recordEvent?.(
    spawnProjectionEvent(decision, 'terminal_created', {
      terminalId: terminal.id,
      tabId: 'activeTabId' in terminal ? String(terminal.activeTabId) : undefined,
    }),
  )
  dependencies.notifyDispatched?.(decision)
  if (dependencies.shouldFocusTerminal?.(decision) ?? true) {
    dependencies.focusTerminal(decision.projectId, terminal.id)
  }
  await dependencies.report({
    requestId: payload.requestId,
    status: 'terminal_created',
    terminalId: terminal.id,
  })
}

// Lord D1: Um evento v1 exclusivo evita os consumidores antigos do Sandbox/Canvas.
export function useAgentSpawnListener(hydrated: boolean) {
  useEffect(() => {
    if (!hydrated) return

    const unlistenPromise = listen<AgentSpawnPayloadV1>('lord-agent-spawn-v1', (event) => {
      const state = useProjectsStore.getState()
      void executeAgentSpawn(event.payload, {
        hydrated,
        projects: state.projects,
        claim: (requestId) => invoke<boolean>('agent_spawn_claim', { requestId }),
        report: async (report) => {
          await invoke('agent_spawn_report', { report })
        },
        createTerminal: (decision) =>
          useProjectsStore
            .getState()
            .createAgentTerminal(decision.projectId, buildSpawnTerminalArgs(decision)),
        recordEvent: (projectionEvent) =>
          useOrchestrationStore.getState().recordEvent(projectionEvent),
        shouldFocusTerminal: (decision) =>
          effectiveOrchestrationPresentation(
            useProjectsStore.getState().preferences.orchestrationPresentation,
          ) === 'dev' &&
          useOrchestrationStore
            .getState()
            .claimAutoFocus(
              decision.parentTerminalId ?? `${decision.origin}:${decision.projectId}`,
            ),
        // Lord: a aba pode nascer fora da vista (outro projeto, grupo recolhido, ou com o
        // auto-foco perdido no debounce). O aviso é o único sinal de que algo externo agiu.
        notifyDispatched: (decision) => {
          const locale = getLocale()
          useUiStore.getState().pushToast({
            title: translate(locale, 'orchestration.toast.title', {
              provider: AGENT_TYPE_LABELS[decision.provider],
            }),
            body: translate(locale, 'orchestration.toast.body', { origin: decision.origin }),
            agent: decision.provider,
          })
        },
        focusTerminal: (projectId, terminalId) => {
          const projects = useProjectsStore.getState()
          const ui = useUiStore.getState()
          projects.setActiveProjectOnly(projectId)
          projects.focusWorkspaceTerminal(projectId, terminalId)
          ui.setActiveTerminal(projectId, terminalId)
          ui.requestPaneFocus(terminalId)
          ui.setActiveView('workspace')
        },
        onError: (error) => console.error('[Lord D1] Could not create agent terminal', error),
      }).catch((error) => console.error('[Lord D1] Could not process spawn request', error))
    })

    return () => {
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [hydrated])
}

// Lord D3 camada 2 (ADR-0013): payload do evento que o Rust emite quando `/spawn`
// recusa um provider fora do conjunto do terminal de origem.
export type SpawnRejectedPayload = {
  jobId: string
  requestId: string
  provider: string
  origin: string
  parentTerminalId: string
  reason: string
}

// Lord D4 (ADR-0013, etapa 3c): a resposta HTTP da recusa vai pro processo que
// chamou /spawn, não pra tela — sem este listener a aba de origem nunca saberia
// que a tentativa foi bloqueada (falha silenciosa, que o ADR proíbe). Registra
// a recusa como um run 'failed' (aparece no painel "Agentes", D4 "durante"/
// "depois") e mostra um aviso dizendo qual botão resolve.
export function useSpawnRejectionListener(hydrated: boolean) {
  useEffect(() => {
    if (!hydrated) return

    const unlistenPromise = listen<SpawnRejectedPayload>('lord-spawn-rejected', (event) => {
      const { jobId, requestId, provider, origin, parentTerminalId, reason } = event.payload
      const locale = getLocale()
      const agent = provider as AgentType
      const providerLabel = AGENT_TYPE_LABELS[agent] ?? provider

      useOrchestrationStore.getState().recordEvent({
        eventId: `${jobId}:failed`,
        type: 'failed',
        runId: jobId,
        requestId,
        jobId,
        provider: agent,
        origin,
        source: 'external_spawn',
        occurredAt: Date.now(),
        parentTerminalId,
        failureReason: reason,
        liveOutput: 'unavailable',
      })

      useUiStore.getState().pushToast({
        title: translate(locale, 'orchestration.toast.blockedTitle', { provider: providerLabel }),
        body: translate(locale, 'orchestration.toast.blockedBody', {
          origin,
          provider: providerLabel,
        }),
        agent,
      })
    })

    return () => {
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [hydrated])
}
