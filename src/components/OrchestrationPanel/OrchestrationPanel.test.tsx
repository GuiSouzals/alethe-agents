import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'

import type { OrchestrationRun } from '../../lib/orchestration'
import { useOrchestrationStore } from '../../stores/orchestrationStore'
import { OrchestrationPanel } from '.'

const externo: OrchestrationRun = {
  runId: 'run-externo',
  requestId: 'request-1',
  jobId: 'spawn-job-externo',
  provider: 'cursor',
  origin: 'claude-code/estudo-IA',
  source: 'external_spawn',
  status: 'terminal_created',
  requestedAt: 1,
  updatedAt: 2,
  terminalId: 'terminal-1',
  liveOutput: 'pty',
}

const interno: OrchestrationRun = {
  runId: 'run-interno',
  requestId: 'agent-1',
  jobId: 'job-interno',
  provider: 'claude',
  origin: 'claude/subagente',
  source: 'internal_subagent',
  status: 'process_exited',
  requestedAt: 3,
  updatedAt: 4,
  liveOutput: 'unavailable',
}

function render() {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => {
    root.render(<OrchestrationPanel />)
  })
  return { container, root }
}

describe('painel global de agentes despachados', () => {
  beforeEach(() => {
    useOrchestrationStore.setState({ runsById: {}, runOrder: [], seenEventIds: {} })
  })

  it('declara a lista vazia em vez de fingir que nada foi despachado', () => {
    const { container, root } = render()
    expect(container.textContent).toContain('No agent dispatched')
    act(() => root.unmount())
  })

  it('lista execuções de qualquer terminal, sem filtrar pelo pane ativo', () => {
    useOrchestrationStore.setState({
      runsById: { [externo.runId]: externo, [interno.runId]: interno },
      runOrder: [externo.runId, interno.runId],
      seenEventIds: {},
    })
    const { container, root } = render()

    expect(container.textContent).toContain('Cursor')
    expect(container.textContent).toContain('Claude Code')
    expect(container.textContent).toContain('claude-code/estudo-IA')
    expect(container.textContent).toContain('spawn-job-externo')
    act(() => root.unmount())
  })

  it('nunca usa vocabulário de aprovação e não inventa terminal para execução sem terminal', () => {
    useOrchestrationStore.setState({
      runsById: { [interno.runId]: interno },
      runOrder: [interno.runId],
      seenEventIds: {},
    })
    const { container, root } = render()

    expect(container.textContent).toContain('internal subagent')
    expect(container.textContent).toContain('No terminal was created for this run')
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/approved|success/i)
    act(() => root.unmount())
  })

  it('mostra a execução mais recente primeiro', () => {
    useOrchestrationStore.setState({
      runsById: { [externo.runId]: externo, [interno.runId]: interno },
      runOrder: [externo.runId, interno.runId],
      seenEventIds: {},
    })
    const { container, root } = render()

    const itens = [...container.querySelectorAll('li')]
    expect(itens[0].textContent).toContain('job-interno')
    act(() => root.unmount())
  })
})
