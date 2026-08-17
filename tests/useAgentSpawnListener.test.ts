import { describe, expect, it, vi } from 'vitest'

import { buildSpawnTerminalArgs, executeAgentSpawn } from '../src/hooks/useAgentSpawnListener'
import {
  resolveSpawnTarget,
  type AgentSpawnPayloadV1,
  type SpawnProject,
} from '../src/hooks/resolveSpawnTarget'
import { useOrchestrationStore } from '../src/stores/orchestrationStore'

// Lord D1: Fixtures do contrato v1 usadas pelos oráculos das Fatias 1 e 2.
const payload = (overrides: Partial<AgentSpawnPayloadV1> = {}): AgentSpawnPayloadV1 => ({
  version: 1,
  requestId: 'request-1',
  jobId: 'spawn-job-1',
  provider: 'codex',
  task: 'Implement the requested slice.',
  cwd: 'C:\\work\\project-a',
  origin: 'lord',
  ...overrides,
})

const projects: SpawnProject[] = [
  { id: 'project-a', defaultCwd: 'C:\\work\\project-a' },
  { id: 'project-b', defaultCwd: 'D:\\work\\project-b' },
]

describe('resolveSpawnTarget', () => {
  // Lord D1: Matriz pura obrigatória da Fatia 2.
  it('matches a valid projectId and uses its default cwd', () => {
    expect(
      resolveSpawnTarget(payload({ projectId: 'project-a', cwd: undefined }), projects, true),
    ).toMatchObject({ status: 'matched', projectId: 'project-a', cwd: 'C:\\work\\project-a' })
  })

  it('returns no_project for an invalid projectId without an equivalent cwd', () => {
    expect(
      resolveSpawnTarget(
        payload({ projectId: 'missing-project', cwd: 'E:\\missing' }),
        projects,
        true,
      ),
    ).toEqual({ status: 'no_project', reason: 'no_matching_project' })
  })

  it('falls back from an invalid projectId to an equivalent cwd', () => {
    expect(
      resolveSpawnTarget(
        payload({ projectId: 'missing-project', cwd: 'c:/WORK/project-a/' }),
        projects,
        true,
      ),
    ).toMatchObject({ status: 'matched', projectId: 'project-a' })
  })

  it('matches an equivalent Windows cwd despite case and separators', () => {
    expect(
      resolveSpawnTarget(payload({ cwd: 'c:/WORK/project-a/' }), projects, true),
    ).toMatchObject({ status: 'matched', projectId: 'project-a' })
  })

  it('returns no_project for a non-equivalent cwd', () => {
    expect(resolveSpawnTarget(payload({ cwd: 'C:\\work\\other' }), projects, true)).toEqual({
      status: 'no_project',
      reason: 'no_matching_project',
    })
  })

  it('rejects an empty task', () => {
    expect(resolveSpawnTarget(payload({ task: '   ' }), projects, true)).toEqual({
      status: 'invalid',
      reason: 'empty_task',
    })
  })

  it('rejects an invalid provider', () => {
    expect(resolveSpawnTarget(payload({ provider: 'unknown' }), projects, true)).toEqual({
      status: 'invalid',
      reason: 'invalid_provider',
    })
  })

  it('rejects a store snapshot that is not hydrated', () => {
    expect(resolveSpawnTarget(payload(), projects, false)).toEqual({
      status: 'invalid',
      reason: 'store_not_hydrated',
    })
  })

  // Lord: honestidade da verificação de escopo (manutenção pós-ADR-0013,
  // item 2) — o código que o Rust manda em `scopeNote` precisa sobreviver
  // à resolução pura, senão a UI nunca teria como mostrá-lo.
  it('propagates scopeNote through to a matched decision', () => {
    expect(
      resolveSpawnTarget(payload({ scopeNote: 'sem_terminal_origem' }), projects, true),
    ).toMatchObject({ status: 'matched', scopeNote: 'sem_terminal_origem' })
  })

  it('leaves scopeNote undefined when the backend verified the scope', () => {
    const decision = resolveSpawnTarget(payload(), projects, true)
    if (decision.status !== 'matched') throw new Error('fixture must match')
    expect(decision.scopeNote).toBeUndefined()
  })

  // Lord ADR-0014 D3: o pedido de captura de transcript, quando o /spawn o
  // inclui, precisa sobreviver à resolução pura até chegar na aba criada.
  it('propagates transcriptCapture through to a matched decision', () => {
    const capture = { demandaDir: 'C:\\work\\.lord\\demandas\\minha-fatia', agente: 'codex', assunto: 'implementacao' }
    expect(
      resolveSpawnTarget(payload({ transcriptCapture: capture }), projects, true),
    ).toMatchObject({ status: 'matched', transcriptCapture: capture })
  })

  it('leaves transcriptCapture undefined when the dispatch did not request it', () => {
    const decision = resolveSpawnTarget(payload(), projects, true)
    if (decision.status !== 'matched') throw new Error('fixture must match')
    expect(decision.transcriptCapture).toBeUndefined()
  })
})

describe('executeAgentSpawn', () => {
  // Lord D1: Oráculos de zero projeto, criação única e idempotência do consumidor.
  it('reports rejected/no_matching_project when there are zero projects', async () => {
    const report = vi.fn(async () => undefined)
    const createTerminal = vi.fn(async () => ({ id: 'terminal-1' }))

    await executeAgentSpawn(payload(), {
      hydrated: true,
      projects: [],
      claim: vi.fn(async () => true),
      report,
      createTerminal,
      focusTerminal: vi.fn(),
    })

    expect(createTerminal).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith({
      requestId: 'request-1',
      status: 'rejected',
      reason: 'no_matching_project',
    })
  })

  it('creates exactly one terminal for a matching project', async () => {
    const report = vi.fn(async () => undefined)
    const createTerminal = vi.fn(async () => ({ id: 'terminal-1' }))
    const focusTerminal = vi.fn()

    await executeAgentSpawn(payload(), {
      hydrated: true,
      projects,
      claim: vi.fn(async () => true),
      report,
      createTerminal,
      focusTerminal,
    })

    expect(createTerminal).toHaveBeenCalledOnce()
    expect(focusTerminal).toHaveBeenCalledWith('project-a', 'terminal-1')
    expect(report).toHaveBeenCalledWith({
      requestId: 'request-1',
      status: 'terminal_created',
      terminalId: 'terminal-1',
    })
  })

  // Lord F3: O prompt é o primeiro input transitório e não vira metadado persistente do run.
  it('builds one solo tab with the prompt as initial input and stable correlation ids', () => {
    const decision = resolveSpawnTarget(payload({ parentTerminalId: 'parent-1' }), projects, true)
    if (decision.status !== 'matched') throw new Error('fixture must match')

    expect(buildSpawnTerminalArgs(decision).firstTab).toEqual({
      type: 'codex',
      cwd: 'C:\\work\\project-a',
      initialInput: 'Implement the requested slice.',
      orchestrationMode: 'solo',
      orchestrationOrigin: 'lord',
      orchestrationRequestId: 'request-1',
      orchestrationJobId: 'spawn-job-1',
      orchestrationParentTerminalId: 'parent-1',
    })
  })

  // Lord ADR-0014 D3: o pedido de captura precisa chegar no firstTab que
  // createAgentTerminal usa pra criar a aba -- senão o spawn nunca aciona
  // a gravação de transcript no chassi (`SpawnPtyArgs.transcriptCapture`).
  it('carries transcriptCapture onto the tab created for a dispatched slice', () => {
    const capture = { demandaDir: 'C:\\work\\.lord\\demandas\\minha-fatia', agente: 'codex', assunto: 'implementacao' }
    const decision = resolveSpawnTarget(payload({ transcriptCapture: capture }), projects, true)
    if (decision.status !== 'matched') throw new Error('fixture must match')

    expect(buildSpawnTerminalArgs(decision).firstTab.transcriptCapture).toEqual(capture)
  })

  // Lord F1: o provider `cursor` precisa atravessar a allowlist do frontend até o tipo da aba.
  it('builds a cursor tab when the spawn asks for the cursor provider', () => {
    const decision = resolveSpawnTarget(payload({ provider: 'cursor' }), projects, true)
    if (decision.status !== 'matched') throw new Error('fixture must match')

    expect(buildSpawnTerminalArgs(decision).firstTab.type).toBe('cursor')
  })

  it('does not create another terminal when the same request is delivered twice', async () => {
    let available = true
    const claim = vi.fn(async () => {
      const result = available
      available = false
      return result
    })
    const createTerminal = vi.fn(async () => ({ id: 'terminal-1' }))

    const dependencies = {
      hydrated: true,
      projects,
      claim,
      report: vi.fn(async () => undefined),
      createTerminal,
      focusTerminal: vi.fn(),
    }
    await executeAgentSpawn(payload(), dependencies)
    await executeAgentSpawn(payload(), dependencies)

    expect(claim).toHaveBeenCalledTimes(2)
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('opens multiple children but grants automatic focus only once per burst', async () => {
    useOrchestrationStore.getState().reset()
    const focusTerminal = vi.fn()
    let terminalNumber = 0
    const dependencies = {
      hydrated: true,
      projects,
      claim: vi.fn(async () => true),
      report: vi.fn(async () => undefined),
      createTerminal: vi.fn(async () => ({ id: `terminal-${++terminalNumber}` })),
      focusTerminal,
      shouldFocusTerminal: (decision: {
        origin: string
        projectId: string
        parentTerminalId?: string
      }) =>
        useOrchestrationStore
          .getState()
          .claimAutoFocus(
            decision.parentTerminalId ?? `${decision.origin}:${decision.projectId}`,
            100,
          ),
    }

    await executeAgentSpawn(payload({ requestId: 'request-1', jobId: 'job-1' }), dependencies)
    await executeAgentSpawn(payload({ requestId: 'request-2', jobId: 'job-2' }), dependencies)

    expect(dependencies.createTerminal).toHaveBeenCalledTimes(2)
    expect(focusTerminal).toHaveBeenCalledOnce()
  })

  // Lord: honestidade da verificação de escopo (manutenção pós-ADR-0013,
  // item 2) — o run projetado precisa carregar o mesmo `scopeNote` que veio
  // do backend, senão o painel "Agentes" não tem como avisar que o escopo
  // não foi conferido para este despacho.
  it('records the scopeNote on the projected event when the backend could not verify scope', async () => {
    const recordEvent = vi.fn()

    await executeAgentSpawn(payload({ scopeNote: 'sem_terminal_origem' }), {
      hydrated: true,
      projects,
      claim: vi.fn(async () => true),
      report: vi.fn(async () => undefined),
      createTerminal: vi.fn(async () => ({ id: 'terminal-1' })),
      focusTerminal: vi.fn(),
      recordEvent,
    })

    expect(recordEvent).toHaveBeenCalled()
    for (const call of recordEvent.mock.calls) {
      expect(call[0]).toMatchObject({ scopeNote: 'sem_terminal_origem' })
    }
  })
})
