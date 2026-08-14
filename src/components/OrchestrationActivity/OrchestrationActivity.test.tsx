import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import type { OrchestrationRun } from '../../lib/orchestration'
import { OrchestrationActivity } from '.'

const run: OrchestrationRun = {
  runId: 'run-1',
  requestId: 'request-1',
  jobId: 'job-1',
  provider: 'codex',
  origin: 'lord',
  source: 'external_spawn',
  status: 'process_exited',
  requestedAt: 1,
  updatedAt: 2,
  parentTerminalId: 'parent-1',
  terminalId: 'child-1',
  ptyId: 'pty-1',
  liveOutput: 'pty',
}

describe('Lord F3 orchestration activity', () => {
  it('labels an ended process without approval language and focuses parent or child', () => {
    const focus = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <OrchestrationActivity
          mode="solo"
          run={run}
          internalRuns={[]}
          currentTerminalId="child-1"
          onFocusTerminal={focus}
        />,
      )
    })

    expect(container.textContent).toContain('ended')
    expect(container.textContent).not.toMatch(/approved/i)
    const buttons = [...container.querySelectorAll('button')]
    act(() => buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(focus.mock.calls).toEqual([['parent-1'], ['child-1']])
    act(() => root.unmount())
  })

  it('renders internal subagents as read-only and states when live output is unavailable', () => {
    const internal: OrchestrationRun = {
      ...run,
      runId: 'internal-1',
      jobId: 'internal-1',
      requestId: 'agent-1',
      source: 'internal_subagent',
      terminalId: undefined,
      ptyId: undefined,
      liveOutput: 'unavailable',
      finalTranscript: 'Final provider output.',
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <OrchestrationActivity
          mode="solo"
          internalRuns={[internal]}
          currentTerminalId="parent-1"
          onFocusTerminal={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain('Internal subagent — read-only view')
    expect(container.textContent).toContain(
      'This provider does not emit live output for this subagent.',
    )
    expect(container.textContent).toContain('Final provider output.')
    act(() => root.unmount())
  })
})
