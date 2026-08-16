import { describe, expect, it } from 'vitest'

import {
  isPaidSpawnProvider,
  PAID_SPAWN_PROVIDERS,
  requiresSpawnConfirmation,
  type SpawnConfirmationTab,
} from '../src/lib/spawnConfirmation'

// Lord: caso base = ordem externa, provider pago, auto-run desligado. Cada teste
// abaixo derruba UMA das três condições e observa o portão fechar.
const externalPaidTab = (overrides: Partial<SpawnConfirmationTab> = {}): SpawnConfirmationTab => ({
  type: 'claude',
  orchestrationRequestId: 'request-1',
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
    expect(requiresSpawnConfirmation(externalPaidTab(), false)).toBe(true)
  })

  // Condição (a): origem externa.
  it('não exige confirmação quando o prompt não veio de fora', () => {
    expect(
      requiresSpawnConfirmation(externalPaidTab({ orchestrationRequestId: undefined }), false),
    ).toBe(false)
  })

  it('trata requestId em branco como criação local', () => {
    expect(
      requiresSpawnConfirmation(externalPaidTab({ orchestrationRequestId: '   ' }), false),
    ).toBe(false)
  })

  it('exige confirmação para qualquer provider pago vindo de fora', () => {
    for (const provider of PAID_SPAWN_PROVIDERS) {
      expect(requiresSpawnConfirmation(externalPaidTab({ type: provider }), false)).toBe(true)
    }
  })

  // Condição (b): provider pago.
  it('não exige confirmação quando o provider é shell', () => {
    expect(requiresSpawnConfirmation(externalPaidTab({ type: 'shell' }), false)).toBe(false)
  })

  // Condição (c): preferência de auto-run.
  it('não exige confirmação quando externalSpawnAutoRun está ligado', () => {
    expect(requiresSpawnConfirmation(externalPaidTab(), true)).toBe(false)
  })

  it('não exige confirmação sem SubTab ativo', () => {
    expect(requiresSpawnConfirmation(undefined, false)).toBe(false)
    expect(requiresSpawnConfirmation(null, false)).toBe(false)
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
    ...overrides,
  })

  it('exige confirmação para automação interna sem orchestrationRequestId', () => {
    expect(requiresSpawnConfirmation(automatedPaidTab(), false)).toBe(true)
  })

  it('não exige confirmação quando automatedSpawn é false/ausente e não há requestId', () => {
    expect(requiresSpawnConfirmation(automatedPaidTab({ automatedSpawn: false }), false)).toBe(
      false,
    )
    expect(requiresSpawnConfirmation({ type: 'claude' }, false)).toBe(false)
  })

  it('ainda respeita provider pago e externalSpawnAutoRun para o caminho automatedSpawn', () => {
    expect(requiresSpawnConfirmation(automatedPaidTab({ type: 'shell' }), false)).toBe(false)
    expect(requiresSpawnConfirmation(automatedPaidTab(), true)).toBe(false)
  })
})
