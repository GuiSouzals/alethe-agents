import { useEffect } from 'react'

import { planCliOpen } from '../lib/cliOpen'
import { useT } from '../lib/i18n'
import { cliTakePendingOpen, listenCliOpenPath } from '../lib/tauri'
import type { AgentType } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

/**
 * Abre no workspace o diretório pedido pelo terminal (`alethe`, `alethe .`,
 * `alethe <path>` — ver `src-tauri/src/cli_launch.rs`).
 *
 * Duas origens, mesma ação:
 * - cold start → `cliTakePendingOpen()` (o backend entrega uma vez só);
 * - app já aberto → evento da segunda instância.
 */

/** Ordem de preferência do agente do primeiro terminal; cai em `shell`. */
const AGENT_PREFERENCE: AgentType[] = [
  'claude',
  'codex',
  'antigravity',
  // Lord F1:
  'cursor',
  'opencode',
  'shell',
]

const AGENT_LABEL: Record<AgentType, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  shell: 'Shell',
  mimo: 'Mimo',
  freebuff: 'Freebuff',
}

export function useCliOpenRequests(hydrated: boolean) {
  const t = useT()

  useEffect(() => {
    // Só depois da hidratação: agir antes de `projects.json` carregar faria
    // `planCliOpen` não achar o projeto existente e duplicar a pasta.
    if (!hydrated) return
    let disposed = false

    const openFromCli = (path: string) => {
      const store = useProjectsStore.getState()
      const plan = planCliOpen(path, store.projects)
      if (!plan) return

      if (plan.kind === 'existing') {
        store.openProjectWorkspace(plan.projectId)
        return
      }

      const project = store.createProject({ name: plan.name, defaultCwd: plan.cwd })
      const agent =
        AGENT_PREFERENCE.find((candidate) => store.preferences.enabledAgents[candidate]) ?? 'shell'
      const terminal = store.createTerminal(project.id, {
        name: AGENT_LABEL[agent],
        cwd: plan.cwd,
        firstTab: { type: agent, cwd: plan.cwd, runtimeProfile: 'lean' },
      })
      store.openTerminalWorkspace(project.id, terminal.id)
      useUiStore.getState().pushToast({ title: t('notif.cliProjectCreated'), body: plan.name })
    }

    // Reexecutar este efeito (troca de idioma) é seguro: o backend já consumiu
    // o pendente e devolve `null` daqui em diante.
    void cliTakePendingOpen()
      .then((path) => {
        if (!disposed && path) openFromCli(path)
      })
      .catch(() => {
        /* best-effort: sem CLI o app abre normal */
      })

    const unlisten = listenCliOpenPath((path) => {
      if (!disposed) openFromCli(path)
    })

    return () => {
      disposed = true
      void unlisten.then((stop) => stop())
    }
  }, [hydrated, t])
}
