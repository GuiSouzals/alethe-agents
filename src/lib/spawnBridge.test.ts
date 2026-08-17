import { describe, expect, it } from 'vitest'

import { SPAWN_BRIDGE_FLAG, SPAWN_BRIDGE_PROMPT_V1, buildSpawnBridgeArgs } from './spawnBridge'
import { UNRESTRICTED_FLAG } from './types'

describe('buildSpawnBridgeArgs', () => {
  it('injeta a ponte quando há 2+ runtimes marcados e o tipo é claude', () => {
    expect(buildSpawnBridgeArgs('claude', ['claude', 'codex'])).toEqual([
      SPAWN_BRIDGE_FLAG,
      SPAWN_BRIDGE_PROMPT_V1,
    ])
    expect(buildSpawnBridgeArgs('claude', ['claude', 'codex', 'cursor'])).toEqual([
      SPAWN_BRIDGE_FLAG,
      SPAWN_BRIDGE_PROMPT_V1,
    ])
  })

  it('não injeta com um runtime só — é o comportamento de antes, nada muda', () => {
    expect(buildSpawnBridgeArgs('claude', ['claude'])).toEqual([])
  })

  it('não injeta com nenhum runtime marcado', () => {
    expect(buildSpawnBridgeArgs('claude', [])).toEqual([])
    expect(buildSpawnBridgeArgs('claude', undefined)).toEqual([])
    expect(buildSpawnBridgeArgs('claude', null)).toEqual([])
  })

  it('não injeta para tipo não-claude, mesmo com 2+ runtimes (lacuna declarada)', () => {
    expect(buildSpawnBridgeArgs('codex', ['codex', 'claude'])).toEqual([])
    expect(buildSpawnBridgeArgs('cursor', ['cursor', 'claude', 'codex'])).toEqual([])
    expect(buildSpawnBridgeArgs('opencode', ['opencode', 'claude'])).toEqual([])
    expect(buildSpawnBridgeArgs('shell', ['shell', 'claude'])).toEqual([])
  })

  it('preserva a flag de modo irrestrito quando as duas coisas valem ao mesmo tempo', () => {
    // Espelha a composição de NewTerminalModal.submit(): flag existente primeiro,
    // ponte depois. Marcar 2+ runtimes não pode apagar o irrestrito.
    const flag = UNRESTRICTED_FLAG.claude
    const composed = [
      ...(flag ? [flag] : []),
      ...buildSpawnBridgeArgs('claude', ['claude', 'codex']),
    ]
    expect(composed).toEqual([
      '--dangerously-skip-permissions',
      SPAWN_BRIDGE_FLAG,
      SPAWN_BRIDGE_PROMPT_V1,
    ])
  })
})

describe('SPAWN_BRIDGE_PROMPT_V1', () => {
  it('cita os campos obrigatórios do contrato v1', () => {
    for (const campo of [
      'version',
      'request_id',
      'provider',
      'task',
      'cwd',
      'project_id',
      'origin',
      'parent_terminal_id',
    ]) {
      expect(SPAWN_BRIDGE_PROMPT_V1).toContain(campo)
    }
  })

  it('ensina o discovery na hora e proíbe guardar o token', () => {
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('LORD_SPAWN_DISCOVERY')
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('X-Alethe-Token')
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('/spawn')
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('LORD_TERMINAL_ID')
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('LORD_RUNTIMES_PERMITIDOS')
  })

  it('declara a proibição de campo extra com o motivo', () => {
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('deny_unknown_fields')
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('400')
  })

  it('trata 403 como fim de assunto e ausência de escopo como desconhecido', () => {
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('provider_nao_permitido')
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('DESCONHECIDO')
  })

  it('exige artefato em disco e proíbe concluir por saída de processo', () => {
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('REPROVADO')
    expect(SPAWN_BRIDGE_PROMPT_V1).toContain('ADR-0008')
  })

  // Regressão contra o prompt legado quebrado do canvas POC
  // (`agentSandboxStore.ts::SPAWN_BRIDGE_PROMPT`): ele mandava o provider com o
  // nome antigo do campo e um campo de pai que não existe na struct v1.
  it('não repete os erros do prompt legado', () => {
    expect(SPAWN_BRIDGE_PROMPT_V1).not.toContain('parent_id')
    expect(SPAWN_BRIDGE_PROMPT_V1).not.toContain('agent=')
    expect(SPAWN_BRIDGE_PROMPT_V1).not.toContain('ALETHE_AGENT_HOOKS_ENDPOINT')
    expect(SPAWN_BRIDGE_PROMPT_V1).not.toContain('ALETHE_AGENT_HOOKS_TOKEN')
  })
})
