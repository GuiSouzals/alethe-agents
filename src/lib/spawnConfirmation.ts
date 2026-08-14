import type { AgentType, SubTab } from './types'

/**
 * Lord: providers cobrados por uso. Uma ordem externa que chega neles começa a
 * gastar dinheiro real no primeiro `\r`, então o prompt precisa passar por um
 * clique humano antes de virar tecla no PTY. `shell` fica de fora de propósito:
 * não é um CLI pago e nunca abre o portão.
 *
 * Espelha a allowlist de `resolveSpawnTarget.ts` menos o `shell`; as duas listas
 * são independentes e precisam mudar juntas.
 */
export const PAID_SPAWN_PROVIDERS = [
  'claude',
  'codex',
  'cursor',
  'opencode',
] as const satisfies readonly AgentType[]

export type PaidSpawnProvider = (typeof PAID_SPAWN_PROVIDERS)[number]

export function isPaidSpawnProvider(provider: string): provider is PaidSpawnProvider {
  return PAID_SPAWN_PROVIDERS.some((candidate) => candidate === provider)
}

/**
 * Recorte mínimo do SubTab que a decisão consome. `orchestrationRequestId` é o
 * discriminador de origem que já existe: só o caminho externo
 * (`useAgentSpawnListener` → `terminalFactory`) preenche esse campo; criação
 * local deixa `undefined`.
 */
export type SpawnConfirmationTab = Pick<SubTab, 'type' | 'orchestrationRequestId'>

/**
 * Decisão pura: este SubTab exige confirmação humana antes do primeiro envio?
 *
 * Exige quando as três condições valem ao mesmo tempo:
 * 1. o prompt veio de fora (`orchestrationRequestId` presente e não vazio);
 * 2. o provider é pago (`PAID_SPAWN_PROVIDERS`);
 * 3. `externalSpawnAutoRun` está desligado.
 *
 * Não lê store, não escreve no PTY e não decide o que fazer depois — só responde
 * se o portão se aplica.
 */
export function requiresSpawnConfirmation(
  tab: SpawnConfirmationTab | null | undefined,
  externalSpawnAutoRun: boolean,
): boolean {
  if (!tab) return false
  const requestId = tab.orchestrationRequestId?.trim()
  if (!requestId) return false
  if (!isPaidSpawnProvider(tab.type)) return false
  return externalSpawnAutoRun !== true
}
