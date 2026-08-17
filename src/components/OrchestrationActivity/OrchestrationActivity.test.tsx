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
      // Lord: run em curso — só essas viram cartão desde a poda da faixa.
      status: 'tool_finished',
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

  // Lord: regressão da faixa que espremia o terminal a zero. Run de processo
  // encerrado não pode voltar a virar cartão — ela é contada, e a lista completa
  // fica na aba "Agentes".
  it('counts finished internal runs instead of rendering a card for each one', () => {
    const internal = (runId: string, status: OrchestrationRun['status']): OrchestrationRun => ({
      ...run,
      runId,
      jobId: runId,
      requestId: runId,
      source: 'internal_subagent',
      status,
      terminalId: undefined,
      ptyId: undefined,
    })
    const openAgents = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <OrchestrationActivity
          mode="solo"
          internalRuns={[
            internal('live-1', 'pty_started'),
            internal('exited-1', 'process_exited'),
            internal('failed-1', 'failed'),
            internal('revoked-1', 'revoked'),
          ]}
          currentTerminalId="parent-1"
          onFocusTerminal={vi.fn()}
          onOpenFinishedList={openAgents}
        />,
      )
    })

    // Só a run viva vira cartão.
    expect(container.querySelectorAll('article').length).toBe(1)
    expect(container.textContent).toContain('running')
    // A contagem das encerradas aparece numa linha só, sem cartão.
    expect(container.textContent).toContain('+3 finished')
    const finished = container.querySelector('button')
    expect(finished?.getAttribute('aria-label')).toBe('See all in the Agents tab')
    act(() => finished?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(openAgents).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
  })

  it('adds the finishedCount prop to the runs it filtered out', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <OrchestrationActivity
          mode="solo"
          internalRuns={[{ ...run, source: 'internal_subagent', status: 'failed' }]}
          finishedCount={2}
          currentTerminalId="parent-1"
          onFocusTerminal={vi.fn()}
        />,
      )
    })

    expect(container.querySelectorAll('article').length).toBe(0)
    expect(container.textContent).toContain('+3 finished')
    // Sem ação de abertura a linha é texto estático, não botão.
    expect(container.querySelector('button')).toBeNull()
    act(() => root.unmount())
  })
})
