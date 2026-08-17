import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'

import type { OrchestrationRun } from '../../lib/orchestration'
import type { Project, Terminal } from '../../lib/types'
import { useOrchestrationStore } from '../../stores/orchestrationStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
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

function terminalFixture(id: string, name: string): Terminal {
  return {
    id,
    name,
    cwd: 'C:/tmp',
    tabs: [],
    activeTabId: '',
    disabled: false,
    laneVisible: null,
  }
}

function projectFixture(id: string, name: string, terminals: Terminal[]): Project {
  return {
    id,
    name,
    groupId: null,
    terminals,
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 1,
  }
}

// Projeto ativo com dois terminais + um segundo projeto, para separar "outro
// terminal do mesmo projeto" de "outro projeto".
function montarProjetos() {
  useProjectsStore.setState((state) => ({
    projects: [
      projectFixture('proj-ativo', 'Projeto ativo', [
        terminalFixture('term-ativo', 'Terminal ativo'),
        terminalFixture('term-irmao', 'Terminal irmao'),
      ]),
      projectFixture('proj-outro', 'Outro projeto', [
        terminalFixture('term-outro', 'Terminal de outro projeto'),
      ]),
    ],
    activeProjectId: 'proj-ativo',
    workspace: { ...state.workspace, focusedTerminalId: 'term-ativo' },
  }))
  useUiStore.setState({ activeTerminal: { projectId: 'proj-ativo', terminalId: 'term-ativo' } })
}

function cabecalhos(container: HTMLElement): string[] {
  return [...container.querySelectorAll('h3')].map((node) => node.textContent ?? '')
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
    useProjectsStore.setState((state) => ({
      projects: [],
      activeProjectId: null,
      workspace: { ...state.workspace, focusedTerminalId: null },
    }))
    useUiStore.setState({ activeTerminal: null })
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

  // Lord: honestidade da verificação de escopo (manutenção pós-ADR-0013, item
  // 2) — a recusa nunca é bloqueada quando não há terminal de origem (ordem
  // externa legítima), mas isso precisa ficar visível, nunca aparentar que
  // o escopo foi conferido.
  it('mostra que o escopo não foi aplicado quando a ordem externa não tem terminal de origem', () => {
    const semOrigem: OrchestrationRun = { ...externo, scopeNote: 'sem_terminal_origem' }
    useOrchestrationStore.setState({
      runsById: { [semOrigem.runId]: semOrigem },
      runOrder: [semOrigem.runId],
      seenEventIds: {},
    })
    const { container, root } = render()

    expect(container.textContent).toContain(
      'Scope not applied: external order with no origin terminal.',
    )
    act(() => root.unmount())
  })

  it('não mostra aviso de escopo quando o backend verificou o despacho', () => {
    useOrchestrationStore.setState({
      runsById: { [externo.runId]: externo },
      runOrder: [externo.runId],
      seenEventIds: {},
    })
    const { container, root } = render()

    expect(container.textContent).not.toContain('Scope not applied')
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

  // Lord: o painel agrupa por terminal de origem em vez de filtrar pelo terminal
  // ativo. Filtrar recriaria a cegueira que ele existe para resolver.
  it('põe a execução despachada pelo terminal ativo no primeiro grupo', () => {
    montarProjetos()
    const doAtivo: OrchestrationRun = {
      ...externo,
      runId: 'run-ativo',
      jobId: 'job-do-ativo',
      parentTerminalId: 'term-ativo',
      terminalId: 'terminal-filho-1',
    }
    useOrchestrationStore.setState({
      runsById: { [doAtivo.runId]: doAtivo },
      runOrder: [doAtivo.runId],
      seenEventIds: {},
    })
    const { container, root } = render()

    expect(cabecalhos(container)[0]).toBe('This terminal')
    const grupos = [...container.querySelectorAll('ol')]
    expect(grupos[0].textContent).toContain('job-do-ativo')
    act(() => root.unmount())
  })

  it('dá grupo próprio, com o nome real do terminal, para outro terminal do mesmo projeto', () => {
    montarProjetos()
    const doAtivo: OrchestrationRun = {
      ...externo,
      runId: 'run-ativo',
      jobId: 'job-do-ativo',
      parentTerminalId: 'term-ativo',
    }
    const doIrmao: OrchestrationRun = {
      ...externo,
      runId: 'run-irmao',
      jobId: 'job-do-irmao',
      parentTerminalId: 'term-irmao',
    }
    useOrchestrationStore.setState({
      runsById: { [doAtivo.runId]: doAtivo, [doIrmao.runId]: doIrmao },
      runOrder: [doAtivo.runId, doIrmao.runId],
      seenEventIds: {},
    })
    const { container, root } = render()

    expect(cabecalhos(container)).toEqual(['This terminal', 'Terminal irmao'])
    const grupos = [...container.querySelectorAll('ol')]
    expect(grupos[0].textContent).toContain('job-do-ativo')
    expect(grupos[1].textContent).toContain('job-do-irmao')
    act(() => root.unmount())
  })

  it('mantém na tela a execução sem terminal de origem conhecido, em grupo próprio', () => {
    montarProjetos()
    const semOrigem: OrchestrationRun = {
      ...externo,
      runId: 'run-sem-origem',
      jobId: 'job-sem-origem',
      terminalId: 'terminal-que-nao-existe-mais',
    }
    useOrchestrationStore.setState({
      runsById: { [semOrigem.runId]: semOrigem },
      runOrder: [semOrigem.runId],
      seenEventIds: {},
    })
    const { container, root } = render()

    expect(cabecalhos(container)).toEqual(['No origin terminal'])
    expect(container.textContent).toContain('job-sem-origem')
    act(() => root.unmount())
  })

  it('reduz a outro projeto a contagem final, sem cartão e sem sumir da contagem da sessão', () => {
    montarProjetos()
    const doAtivo: OrchestrationRun = {
      ...externo,
      runId: 'run-ativo',
      jobId: 'job-do-ativo',
      parentTerminalId: 'term-ativo',
    }
    const deOutroProjeto: OrchestrationRun = {
      ...externo,
      runId: 'run-outro-projeto',
      jobId: 'job-de-outro-projeto',
      parentTerminalId: 'term-outro',
      terminalId: 'term-outro',
    }
    useOrchestrationStore.setState({
      runsById: { [doAtivo.runId]: doAtivo, [deOutroProjeto.runId]: deOutroProjeto },
      runOrder: [doAtivo.runId, deOutroProjeto.runId],
      seenEventIds: {},
    })
    const { container, root } = render()

    expect(container.textContent).not.toContain('job-de-outro-projeto')
    expect(container.querySelectorAll('li')).toHaveLength(1)
    expect(container.textContent).toContain('1 in other projects')
    // A contagem do cabeçalho é da sessão inteira, não do que está agrupado.
    expect(container.textContent).toContain('2 in this session')
    act(() => root.unmount())
  })

  // Lord: `parentTerminalId` carrega duas identidades. Subagente interno grava
  // `Terminal.id`; ordem externa grava o `ptyId` da aba que pediu (é o único id que
  // o processo conhece de si mesmo, via `LORD_TERMINAL_ID`). Sem traduzir ptyId ->
  // `Terminal.id`, o casamento cai no `terminalId` de reserva e a execução aparece
  // sob a aba que ela CRIOU em vez do terminal que a PEDIU — silenciosamente, com a
  // tela parecendo certa. Este teste separa os dois: quem pediu foi `term-ativo`
  // (pelo ptyId), e a aba criada foi `term-irmao`.
  it('agrupa ordem externa pelo terminal que pediu quando o vínculo vem como ptyId', () => {
    montarProjetos()
    useProjectsStore.setState((state) => ({
      projects: state.projects.map((project) =>
        project.id === 'proj-ativo'
          ? {
              ...project,
              terminals: project.terminals.map((terminal) =>
                terminal.id === 'term-ativo'
                  ? { ...terminal, tabs: [{ ptyId: 'pty-do-ativo' }] as Terminal['tabs'] }
                  : terminal,
              ),
            }
          : project,
      ),
    }))
    const pediuPeloPtyId: OrchestrationRun = {
      ...externo,
      runId: 'run-por-ptyid',
      jobId: 'job-por-ptyid',
      parentTerminalId: 'pty-do-ativo',
      terminalId: 'term-irmao',
    }
    useOrchestrationStore.setState({
      runsById: { [pediuPeloPtyId.runId]: pediuPeloPtyId },
      runOrder: [pediuPeloPtyId.runId],
      seenEventIds: {},
    })
    const { container, root } = render()

    expect(cabecalhos(container)).toEqual(['This terminal'])
    expect(container.textContent).toContain('job-por-ptyid')
    act(() => root.unmount())
  })
})
