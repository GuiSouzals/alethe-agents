import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import type { OrchestrationEvent } from '../lib/orchestration'
import type { Project } from '../lib/types'
import { useOrchestrationStore } from '../stores/orchestrationStore'
import { useProjectsStore } from '../stores/projectsStore'

export type InternalSubagentHookPayload = {
  hook_event_name?: string
  session_id?: string
  agent_id?: string
  agent_type?: string
  tool_name?: string
  tool_use_id?: string
  last_assistant_message?: string
}

// Lord F3: Só correlaciona sessão quando existe exatamente um terminal possível.
export function findUniqueTerminalForSession(
  projects: readonly Project[],
  sessionId: string,
): string | undefined {
  const matches = projects.flatMap((project) =>
    project.terminals.filter((terminal) =>
      terminal.tabs.some((tab) => tab.sessionId === sessionId),
    ),
  )
  return matches.length === 1 ? matches[0].id : undefined
}

// Lord F3: Usa somente IDs e texto final realmente emitidos pelo hook do provider.
export function internalSubagentEvents(
  payload: InternalSubagentHookPayload,
  projects: readonly Project[],
  occurredAt = Date.now(),
): OrchestrationEvent[] {
  const eventName = payload.hook_event_name
  const agentId = payload.agent_id?.trim()
  const sessionId = payload.session_id?.trim()
  if (!eventName || !agentId || !sessionId) return []

  const runId = `internal:${sessionId}:${agentId}`
  const parentTerminalId = findUniqueTerminalForSession(projects, sessionId)
  const base = {
    runId,
    requestId: agentId,
    jobId: runId,
    provider: 'claude' as const,
    origin: payload.agent_type?.trim() || 'Claude Code',
    source: 'internal_subagent' as const,
    occurredAt,
    parentTerminalId,
    internalAgentId: agentId,
    liveOutput: 'unavailable' as const,
  }

  if (eventName === 'SubagentStart') {
    return [
      { ...base, eventId: `${runId}:requested`, type: 'requested' },
      { ...base, eventId: `${runId}:accepted`, type: 'accepted' },
    ]
  }
  if (eventName === 'SubagentStop') {
    return [
      {
        ...base,
        eventId: `${runId}:process_exited`,
        type: 'process_exited',
        finalTranscript: payload.last_assistant_message,
      },
    ]
  }
  if ((eventName === 'PreToolUse' || eventName === 'PostToolUse') && payload.tool_use_id) {
    const type = eventName === 'PreToolUse' ? 'tool_started' : 'tool_finished'
    return [
      {
        ...base,
        eventId: `${runId}:${type}:${payload.tool_use_id}`,
        type,
        toolCallId: payload.tool_use_id,
        toolName: payload.tool_name,
      },
    ]
  }
  return []
}

// Lord F3: Listener global projeta subagentes internos sem criar PTY ou xterm falso.
export function useInternalSubagentProjection(hydrated: boolean) {
  useEffect(() => {
    if (!hydrated) return
    const unlistenPromise = listen<InternalSubagentHookPayload>('agent-hook', (event) => {
      const projects = useProjectsStore.getState().projects
      const projection = useOrchestrationStore.getState()
      for (const projected of internalSubagentEvents(event.payload, projects)) {
        projection.recordEvent(projected)
      }
    })
    return () => {
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [hydrated])
}
