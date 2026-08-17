import { sameCwd } from '../lib/paths'
import type { AgentType, Project } from '../lib/types'

// Lord D1: O chassi recebe o executor pronto e valida apenas o contrato de execução.
// Lord F1: espelha a allowlist do Rust em `agent_events.rs::parse_spawn_request`;
// as duas são independentes e precisam mudar juntas.
const SPAWN_PROVIDERS = [
  'shell',
  'claude',
  'codex',
  'cursor',
  'opencode',
] as const satisfies readonly AgentType[]

export type SpawnProvider = (typeof SPAWN_PROVIDERS)[number]

export type AgentSpawnPayloadV1 = {
  version: number
  requestId: string
  jobId: string
  provider: string
  task: string
  cwd?: string
  projectId?: string
  origin: string
  name?: string
  parentTerminalId?: string
  /**
   * Lord: honestidade da verificação de escopo (manutenção pós-ADR-0013,
   * item 2). `undefined` = o `/spawn` verificou o provider contra a
   * allowlist real do terminal de origem. Presente = a checagem NÃO pôde
   * ser aplicada (ordem externa sem `parentTerminalId`, ou terminal
   * desconhecido/pré-D2) — o pedido não foi bloqueado por isso (é a
   * decisão certa, ver `agent_events.rs::provider_allowed`), mas a tela
   * precisa dizer que o escopo não foi conferido, nunca aparentar que foi.
   */
  scopeNote?: string
  /**
   * Lord ADR-0014 D3: pedido explícito de captura automática de transcript
   * pra a aba que este spawn cria (ver `SubTab.transcriptCapture`). Ausente
   * = sem captura — o chassi nunca infere sozinho que um despacho "é de uma
   * fatia"; só grava quando o orquestrador (que já sabe o slug da demanda)
   * pede.
   */
  transcriptCapture?: { demandaDir: string; agente: string; assunto: string }
}

export type SpawnProject = Pick<Project, 'id' | 'defaultCwd'>

export type SpawnResolution =
  | {
      status: 'matched'
      projectId: string
      cwd: string
      provider: SpawnProvider
      task: string
      name?: string
      requestId: string
      jobId: string
      origin: string
      parentTerminalId?: string
      scopeNote?: string
      transcriptCapture?: { demandaDir: string; agente: string; assunto: string }
    }
  | {
      status: 'invalid'
      reason:
        | 'store_not_hydrated'
        | 'unsupported_version'
        | 'invalid_request_id'
        | 'invalid_job_id'
        | 'invalid_provider'
        | 'empty_task'
        | 'invalid_origin'
        | 'missing_target'
        | 'missing_cwd'
    }
  | { status: 'no_project'; reason: 'no_matching_project' }

function isSpawnProvider(provider: string): provider is SpawnProvider {
  return SPAWN_PROVIDERS.some((candidate) => candidate === provider)
}

// Lord D1: Resolução pura; nenhuma leitura de store, criação de terminal ou navegação ocorre aqui.
export function resolveSpawnTarget(
  payload: AgentSpawnPayloadV1,
  projects: readonly SpawnProject[],
  hydrated: boolean,
): SpawnResolution {
  if (!hydrated) return { status: 'invalid', reason: 'store_not_hydrated' }
  if (payload.version !== 1) return { status: 'invalid', reason: 'unsupported_version' }
  if (typeof payload.requestId !== 'string' || !payload.requestId.trim()) {
    return { status: 'invalid', reason: 'invalid_request_id' }
  }
  if (typeof payload.jobId !== 'string' || !payload.jobId.trim()) {
    return { status: 'invalid', reason: 'invalid_job_id' }
  }
  if (typeof payload.provider !== 'string' || !isSpawnProvider(payload.provider)) {
    return { status: 'invalid', reason: 'invalid_provider' }
  }
  if (typeof payload.task !== 'string' || !payload.task.trim()) {
    return { status: 'invalid', reason: 'empty_task' }
  }
  if (typeof payload.origin !== 'string' || !payload.origin.trim()) {
    return { status: 'invalid', reason: 'invalid_origin' }
  }

  const requestedProjectId = payload.projectId?.trim()
  const requestedCwd = payload.cwd?.trim()
  if (!requestedProjectId && !requestedCwd) {
    return { status: 'invalid', reason: 'missing_target' }
  }

  const projectById = requestedProjectId
    ? projects.find((project) => project.id === requestedProjectId)
    : undefined
  if (projectById) {
    const cwd = requestedCwd || projectById.defaultCwd?.trim()
    if (!cwd) return { status: 'invalid', reason: 'missing_cwd' }
    return {
      status: 'matched',
      projectId: projectById.id,
      cwd,
      provider: payload.provider,
      task: payload.task,
      name: payload.name,
      requestId: payload.requestId,
      jobId: payload.jobId,
      origin: payload.origin,
      parentTerminalId: payload.parentTerminalId,
      scopeNote: payload.scopeNote,
      transcriptCapture: payload.transcriptCapture,
    }
  }

  const projectByCwd = requestedCwd
    ? projects.find((project) => project.defaultCwd && sameCwd(project.defaultCwd, requestedCwd))
    : undefined
  if (!projectByCwd) return { status: 'no_project', reason: 'no_matching_project' }

  return {
    status: 'matched',
    projectId: projectByCwd.id,
    cwd: requestedCwd as string,
    provider: payload.provider,
    task: payload.task,
    name: payload.name,
    requestId: payload.requestId,
    jobId: payload.jobId,
    origin: payload.origin,
    parentTerminalId: payload.parentTerminalId,
    scopeNote: payload.scopeNote,
    transcriptCapture: payload.transcriptCapture,
  }
}
