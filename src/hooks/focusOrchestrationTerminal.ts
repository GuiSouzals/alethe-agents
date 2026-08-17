import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

// Lord: navegação por ID persistido. Se o terminal alvo não existir mais, não adivinha
// nem cria nada — a projeção de orquestração é efêmera e pode citar terminal já fechado.
//
// Aceita as DUAS identidades que a projeção usa em `parentTerminalId`, porque quem
// chama não tem como saber qual recebeu: subagente interno grava `Terminal.id`
// (`useInternalSubagentProjection.ts`), enquanto ordem externa grava o `ptyId` da aba
// que pediu — é o único id que o processo conhece de si mesmo, injetado como
// `LORD_TERMINAL_ID` (ver `src-tauri/src/agent_events.rs`, em
// `extract_runtimes_permitidos`). Antes daqui só o casamento por `Terminal.id` existia,
// então o botão "Pai" de uma ordem externa não achava nada e falhava calado.
export function focusOrchestrationTerminal(terminalIdOrPtyId: string): boolean {
  const projects = useProjectsStore.getState()
  let terminalId = terminalIdOrPtyId
  let targetProject = projects.projects.find((project) =>
    project.terminals.some((candidate) => candidate.id === terminalId),
  )
  if (!targetProject) {
    // Segunda tentativa: o valor recebido é um `ptyId` de aba.
    for (const project of projects.projects) {
      const owner = project.terminals.find((candidate) =>
        candidate.tabs.some((tab) => tab.ptyId === terminalIdOrPtyId),
      )
      if (owner) {
        targetProject = project
        terminalId = owner.id
        break
      }
    }
  }
  if (!targetProject) return false

  const ui = useUiStore.getState()
  projects.setActiveProjectOnly(targetProject.id)
  projects.focusWorkspaceTerminal(targetProject.id, terminalId)
  ui.setActiveTerminal(targetProject.id, terminalId)
  ui.requestPaneFocus(terminalId)
  ui.setActiveView('workspace')
  return true
}
