import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import { AGENT_TYPE_LABELS } from '../lib/types'
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
  onError?: (error: unknown) => void
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

  if (!(await dependencies.claim(payload.requestId))) return

  let terminal: { id: string }
  try {
    terminal = await dependencies.createTerminal(decision)
  } catch (error) {
    dependencies.onError?.(error)
    await dependencies.report({
      requestId: payload.requestId,
      status: 'rejected',
      reason: 'terminal_creation_failed',
    })
    return
  }

  dependencies.focusTerminal(decision.projectId, terminal.id)
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
          useProjectsStore.getState().createAgentTerminal(decision.projectId, {
            name: decision.name?.trim() || AGENT_TYPE_LABELS[decision.provider],
            cwd: decision.cwd,
            firstTab: {
              type: decision.provider,
              cwd: decision.cwd,
              initialInput: decision.task,
            },
          }),
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
