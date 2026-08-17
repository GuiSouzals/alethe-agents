import { describe, expect, it } from 'vitest'

import { buildSchedulerTaskFirstTab } from '../src/stores/schedulerStore'
import { requiresSpawnConfirmation } from '../src/lib/spawnConfirmation'

// Lord: o agente de task do scheduler nasce de `AgentSpawnRequested` (tick do backend,
// sem clique humano) — mesma categoria de "automação" que o portão de confirmação de
// provider pago cobre. Estes testes travam as duas propriedades que fecham essa lacuna:
// o prompt não pode viajar por `extraArgs` (escaparia do gate), e o SubTab resultante
// precisa satisfazer `requiresSpawnConfirmation` para provider pago.
describe('buildSchedulerTaskFirstTab', () => {
  it('carrega o prompt em initialInput, não em extraArgs', () => {
    const firstTab = buildSchedulerTaskFirstTab('claude', 'Corrigir o bug de login')

    expect(firstTab.initialInput).toContain('Corrigir o bug de login')
    expect(firstTab).not.toHaveProperty('extraArgs')
  })

  it('marca automatedSpawn para acionar o portão de confirmação', () => {
    const firstTab = buildSchedulerTaskFirstTab('codex', 'Task qualquer')

    expect(firstTab.automatedSpawn).toBe(true)
    expect(requiresSpawnConfirmation(firstTab)).toBe(true)
  })

  it('não força confirmação quando o provider não é pago (shell)', () => {
    const firstTab = buildSchedulerTaskFirstTab('shell', 'Task qualquer')

    expect(requiresSpawnConfirmation(firstTab)).toBe(false)
  })

  // Lord: o portão deixou de ser a preferência global `externalSpawnAutoRun` e
  // passou a ser campo da aba. O agendador declara o campo LIGADO em vez de
  // depender da ausência dele — trave isso, porque é o que protege o gasto de um
  // tick que roda sem ninguém olhando.
  it('declara o portão de gasto ligado, sem depender de default alheio', () => {
    const firstTab = buildSchedulerTaskFirstTab('claude', 'Task qualquer')

    expect(firstTab.exigeConfirmacaoDeGasto).toBe(true)
  })

  it('só dispensa o portão com um false explícito na aba', () => {
    const firstTab = buildSchedulerTaskFirstTab('claude', 'Task qualquer')

    expect(requiresSpawnConfirmation({ ...firstTab, exigeConfirmacaoDeGasto: false })).toBe(false)
  })
})
