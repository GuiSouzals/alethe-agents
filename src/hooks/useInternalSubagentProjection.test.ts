import { describe, expect, it } from 'vitest'

import { makeDefaultTerminal } from '../lib/terminalFactory'
import type { Project } from '../lib/types'
import {
  findUniqueTerminalForSession,
  internalSubagentEvents,
} from './useInternalSubagentProjection'

function projectWithSession(terminalId: string, sessionId: string): Project {
  const terminal = makeDefaultTerminal({
    name: 'Claude',
    cwd: 'C:\\work',
    firstTab: { type: 'claude', cwd: 'C:\\work' },
  })
  terminal.id = terminalId
  terminal.tabs[0].sessionId = sessionId
  return {
    id: `project-${terminalId}`,
    name: 'Project',
    groupId: null,
    terminals: [terminal],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 1,
  }
}

describe('Lord F3 internal subagent projection', () => {
  it('correlates only a unique parent session', () => {
    expect(
      findUniqueTerminalForSession([projectWithSession('parent-1', 'session-1')], 'session-1'),
    ).toBe('parent-1')
    expect(
      findUniqueTerminalForSession(
        [projectWithSession('parent-1', 'session-1'), projectWithSession('parent-2', 'session-1')],
        'session-1',
      ),
    ).toBeUndefined()
  })

  it('uses stable provider ids and only the emitted final transcript', () => {
    const projects = [projectWithSession('parent-1', 'session-1')]
    const started = internalSubagentEvents(
      { hook_event_name: 'SubagentStart', session_id: 'session-1', agent_id: 'agent-1' },
      projects,
      1,
    )
    const stopped = internalSubagentEvents(
      {
        hook_event_name: 'SubagentStop',
        session_id: 'session-1',
        agent_id: 'agent-1',
        last_assistant_message: 'Provider-emitted transcript.',
      },
      projects,
      2,
    )

    expect(started.map((item) => item.type)).toEqual(['requested', 'accepted'])
    expect(started[0]).toMatchObject({ parentTerminalId: 'parent-1', liveOutput: 'unavailable' })
    expect(stopped[0].finalTranscript).toBe('Provider-emitted transcript.')
  })

  it('ignores hooks without stable agent and session ids', () => {
    expect(internalSubagentEvents({ hook_event_name: 'SubagentStart' }, [], 1)).toEqual([])
  })
})
