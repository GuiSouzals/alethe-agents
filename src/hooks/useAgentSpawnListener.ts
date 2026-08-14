import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import { sameCwd } from '../lib/paths'
import { AGENT_TYPE_LABELS, ALL_AGENT_TYPES, type AgentType } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

// Lord B1: This payload is execution-only; routing and agent selection arrive precomputed.
type AgentSpawnPayload = {
  agent?: string
  task?: string
  cwd?: string
  projectId?: string
  name?: string
}

// Lord B1: Resolve only an existing workspace project and never create or select work implicitly.
function resolveProjectId(payload: AgentSpawnPayload): string | null {
  const { projects } = useProjectsStore.getState()
  if (payload.projectId && projects.some((project) => project.id === payload.projectId)) {
    return payload.projectId
  }
  if (!payload.cwd) return null
  return (
    projects.find(
      (project) => project.defaultCwd && sameCwd(project.defaultCwd, payload.cwd as string),
    )?.id ?? null
  )
}

// Lord B1: Bridge authenticated spawn events into the normal persistent workspace terminal flow.
export function useAgentSpawnListener(hydrated: boolean) {
  useEffect(() => {
    if (!hydrated) return

    const unlistenPromise = listen<AgentSpawnPayload>('agent-spawn', (event) => {
      const payload = event.payload
      if (
        !payload.cwd ||
        typeof payload.task !== 'string' ||
        !ALL_AGENT_TYPES.includes(payload.agent as AgentType)
      ) {
        console.warn('[Lord B1] Ignored invalid agent-spawn payload')
        return
      }

      const projectId = resolveProjectId(payload)
      if (!projectId) {
        console.warn('[Lord B1] Ignored agent-spawn without a matching workspace project')
        return
      }

      const agent = payload.agent as AgentType
      void useProjectsStore
        .getState()
        .createAgentTerminal(projectId, {
          name: payload.name?.trim() || AGENT_TYPE_LABELS[agent],
          cwd: payload.cwd,
          firstTab: {
            type: agent,
            cwd: payload.cwd,
            initialInput: payload.task,
          },
        })
        .then((terminal) => {
          const projects = useProjectsStore.getState()
          const ui = useUiStore.getState()
          projects.setActiveProjectOnly(projectId)
          projects.focusWorkspaceTerminal(projectId, terminal.id)
          ui.setActiveTerminal(projectId, terminal.id)
          ui.requestPaneFocus(terminal.id)
          ui.setActiveView('workspace')
        })
        .catch((error) => console.error('[Lord B1] Could not create agent terminal', error))
    })

    return () => {
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [hydrated])
}
