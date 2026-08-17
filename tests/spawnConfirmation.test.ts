import { describe, expect, it } from 'vitest'

import {
  isPaidSpawnProvider,
  PAID_SPAWN_PROVIDERS,
  requiresSpawnConfirmation,
  type SpawnConfirmationTab,
} from '../src/lib/spawnConfirmation'

// Lord: caso base = ordem externa, provider pago, aba pedindo confirmação. Cada
// teste abaixo derruba UMA das três condições e observa o portão fechar.
//
// A condição (c) era a preferência GLOBAL `externalSpawnAutoRun`, passada como
// segundo argumento. Agora é o campo da própria aba (`exigeConfirmacaoDeGasto`),
// e a função recebe só a aba — desligar o portão para uma cadeia automática não
// pode mais desligá-lo em todo terminal esquecido. O caso base reproduz o que a
// criação de aba grava hoje: o campo ligado.
const externalPaidTab = (overrides: Partial<SpawnConfirmationTab> = {}): SpawnConfirmationTab => ({
  type: 'claude',
  orchestrationRequestId: 'request-1',
  exigeConfirmacaoDeGasto: true,
  ...overrides,
})

describe('PAID_SPAWN_PROVIDERS', () => {
  it('lista exatamente os quatro CLIs cobrados por uso', () => {
    expect([...PAID_SPAWN_PROVIDERS]).toEqual(['claude', 'codex', 'cursor', 'opencode'])
  })

  it('não considera o shell um provider pago', () => {
    expect(isPaidSpawnProvider('shell')).toBe(false)
  })

  it('reconhece cada provider pago da lista', () => {
    for (const provider of PAID_SPAWN_PROVIDERS) {
      expect(isPaidSpawnProvider(provider)).toBe(true)
    }
  })
})

describe('requiresSpawnConfirmation', () => {
  it('exige confirmação quando as três condições valem juntas', () => {
    expect(requiresSpawnConfirmation(externalPaidTab())).toBe(true)
  })

  // Condição (a): origem externa.
  it('não exige confirmação quando o prompt não veio de fora', () => {
    expect(requiresSpawnConfirmation(externalPaidTab({ orchestrationRequestId: undefined }))).toBe(
      false,
    )
  })

  it('trata requestId em branco como criação local', () => {
    expect(requiresSpawnConfirmation(externalPaidTab({ orchestrationRequestId: '   ' }))).toBe(false)
  })

  it('exige confirmação para qualquer provider pago vindo de fora', () => {
    for (const provider of PAID_SPAWN_PROVIDERS) {
      expect(requiresSpawnConfirmation(externalPaidTab({ type: provider }))).toBe(true)
    }
  })

  // Condição (b): provider pago.
  it('não exige confirmação quando o provider é shell', () => {
    expect(requiresSpawnConfirmation(externalPaidTab({ type: 'shell' }))).toBe(false)
  })

  // Condição (c): o campo da própria aba. Só um `false` EXPLÍCITO dispensa o
  // portão — é o único jeito de o usuário renunciar ao clique, e vale só para
  // esta aba.
  it('não exige confirmação quando a aba dispensa o portão explicitamente', () => {
    expect(requiresSpawnConfirmation(externalPaidTab({ exigeConfirmacaoDeGasto: false }))).toBe(
      false,
    )
  })

  it('exige confirmação quando a aba pede o portão', () => {
    expect(requiresSpawnConfirmation(externalPaidTab({ exigeConfirmacaoDeGasto: true }))).toBe(true)
  })

  // Lord: aba anterior ao campo (ou vinda de um caminho que o perdeu, como um
  // rebuild de sessão) não pode virar despacho sem clique. Ausência é lado
  // seguro, nunca "o usuário já dispensou". O cast representa exatamente esse
  // dado legado: o campo é obrigatório no tipo, mas não estava no disco.
  it('exige confirmação quando a aba não declara o campo', () => {
    const abaLegada = {
      type: 'claude',
      orchestrationRequestId: 'request-1',
    } as SpawnConfirmationTab
    expect(requiresSpawnConfirmation(abaLegada)).toBe(true)
  })

  it('não exige confirmação sem SubTab ativo', () => {
    expect(requiresSpawnConfirmation(undefined)).toBe(false)
    expect(requiresSpawnConfirmation(null)).toBe(false)
  })
})

// Lord: segunda porta de entrada da condição (a) — automação interna (ex.: schedulerStore)
// sem `orchestrationRequestId`, via `automatedSpawn`.
describe('requiresSpawnConfirmation — automatedSpawn (disparo interno sem clique humano)', () => {
  const automatedPaidTab = (
    overrides: Partial<SpawnConfirmationTab> = {},
  ): SpawnConfirmationTab => ({
    type: 'claude',
    automatedSpawn: true,
    exigeConfirmacaoDeGasto: true,
    ...overrides,
  })

  it('exige confirmação para automação interna sem orchestrationRequestId', () => {
    expect(requiresSpawnConfirmation(automatedPaidTab())).toBe(true)
  })

  it('não exige confirmação quando automatedSpawn é false/ausente e não há requestId', () => {
    expect(requiresSpawnConfirmation(automatedPaidTab({ automatedSpawn: false }))).toBe(false)
    expect(
      requiresSpawnConfirmation({ type: 'claude', exigeConfirmacaoDeGasto: true }),
    ).toBe(false)
  })

  it('ainda respeita provider pago e o campo da aba no caminho automatedSpawn', () => {
    expect(requiresSpawnConfirmation(automatedPaidTab({ type: 'shell' }))).toBe(false)
    expect(requiresSpawnConfirmation(automatedPaidTab({ exigeConfirmacaoDeGasto: false }))).toBe(
      false,
    )
  })
})
