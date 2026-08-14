import { sameCwd } from '../lib/paths'
import type { AgentType, Project } from '../lib/types'

// Lord D1: O chassi recebe o executor pronto e valida apenas o contrato de execução.
const SPAWN_PROVIDERS = [
  'shell',
  'claude',
  'codex',
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
  }
}
