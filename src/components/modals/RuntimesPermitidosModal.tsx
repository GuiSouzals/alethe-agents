import { CircleCheck } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { AGENT_TYPE_LABELS, ALL_AGENT_TYPES, type AgentType } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './RuntimesPermitidosModal.module.css'

/**
 * Lord ADR-0013 D2/D4 (etapa 3b): editor do conjunto de runtimes que ESTE
 * terminal pode acionar via `/spawn`. Só o usuário chama a ação que muda o
 * conjunto (`setSubTabRuntimesPermitidos`) — o agente nunca amplia o próprio
 * escopo, mesmo que peça (D2).
 */
export function RuntimesPermitidosModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'runtimesPermitidos')
  const context = useUiStore((s) => s.modalContext) as {
    projectId?: string
    terminalId?: string
    tabId?: string
  } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const setSubTabRuntimesPermitidos = useProjectsStore((s) => s.setSubTabRuntimesPermitidos)
  const enabled = useProjectsStore((s) => s.preferences.enabledAgents)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
  const tab = useProjectsStore((s) => {
    if (!context?.projectId || !context?.terminalId || !context?.tabId) return null
    const project = s.projects.find((p) => p.id === context.projectId)
    const terminal = project?.terminals.find((item) => item.id === context.terminalId)
    return terminal?.tabs.find((item) => item.id === context.tabId) ?? null
  })

  const current = tab?.runtimesPermitidos ?? []
  const visibleAgents = ALL_AGENT_TYPES.filter((agent) => enabled[agent])

  const toggle = (agent: AgentType) => {
    if (!context?.projectId || !context?.terminalId || !context?.tabId) return
    const next = current.includes(agent)
      ? current.filter((item) => item !== agent)
      : [...current, agent]
    setSubTabRuntimesPermitidos(context.projectId, context.terminalId, context.tabId, next)
  }

  return (
    <Modal open={open} onClose={closeModal} title={t('term.stepScope')} width={420}>
      <p className={styles.hint}>{t('term.stepScopeHint')}</p>
      <div className={styles.chips}>
        {visibleAgents.map((agent) => {
          const checked = current.includes(agent)
          return (
            <button
              key={agent}
              type="button"
              className={`${styles.chip} ${checked ? styles.chipActive : ''}`}
              onClick={() => toggle(agent)}
              aria-pressed={checked}
            >
              <AgentIcon type={agent} size={14} theme={terminalTheme} />
              <span>{AGENT_TYPE_LABELS[agent]}</span>
              {checked ? <CircleCheck size={13} /> : null}
            </button>
          )
        })}
      </div>
      {current.length === 0 ? (
        <p className={styles.warning}>{t('term.stepScopeEmptyWarning')}</p>
      ) : null}
      <div className={controls.field}>
        <button type="button" className={controls.btn} onClick={closeModal}>
          {t('term.cancel')}
        </button>
      </div>
    </Modal>
  )
}
