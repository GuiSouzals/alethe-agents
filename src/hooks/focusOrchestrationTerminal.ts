import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

// Lord: navegação por ID persistido. Se o terminal alvo não existir mais, não adivinha
// nem cria nada — a projeção de orquestração é efêmera e pode citar terminal já fechado.
export function focusOrchestrationTerminal(terminalId: string): boolean {
  const projects = useProjectsStore.getState()
  const targetProject = projects.projects.find((project) =>
    project.terminals.some((candidate) => candidate.id === terminalId),
  )
  if (!targetProject) return false

  const ui = useUiStore.getState()
  projects.setActiveProjectOnly(targetProject.id)
  projects.focusWorkspaceTerminal(targetProject.id, terminalId)
  ui.setActiveTerminal(targetProject.id, terminalId)
  ui.requestPaneFocus(terminalId)
  ui.setActiveView('workspace')
  return true
}
