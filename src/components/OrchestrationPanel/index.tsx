import { Radar, TerminalSquare } from 'lucide-react'
import { useMemo } from 'react'

import { focusOrchestrationTerminal } from '../../hooks/focusOrchestrationTerminal'
import { useT } from '../../lib/i18n'
import { ORCHESTRATION_STATUS_KEYS } from '../../lib/orchestration'
import { AGENT_TYPE_LABELS } from '../../lib/types'
import { useOrchestrationStore } from '../../stores/orchestrationStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { AgentIcon } from '../icons/AgentIcons'
import { EmptyState } from '../EmptyState'
import styles from './OrchestrationPanel.module.css'

// Lord: até aqui, um agente despachado só era visível dentro do painel do terminal que
// ele mesmo criou. Quem estava noutro projeto ou com o grupo recolhido não via nada.
// Esta é a única superfície que lista todas as execuções sem filtrar por terminal.
export function OrchestrationPanel() {
  const t = useT()
  const runsById = useOrchestrationStore((state) => state.runsById)
  const runOrder = useOrchestrationStore((state) => state.runOrder)
  const theme = useProjectsStore((state) => state.preferences.uiTheme)
  const autoRun = useProjectsStore((state) => state.preferences.externalSpawnAutoRun)
  const setPreferences = useProjectsStore((state) => state.setPreferences)

  // Mais recente primeiro: runOrder é ordem de inserção, append-only.
  const runs = useMemo(
    () =>
      runOrder
        .map((runId) => runsById[runId])
        .filter((run): run is NonNullable<typeof run> => Boolean(run))
        .reverse(),
    [runOrder, runsById],
  )

  return (
    <section className={styles.panel} aria-label={t('orchestration.panel.title')}>
      <header className={styles.header}>
        <Radar size={15} />
        <span className={styles.headerTitle}>{t('orchestration.panel.title')}</span>
        {runs.length > 0 ? (
          <span className={styles.count}>
            {t('orchestration.panel.count', { count: String(runs.length) })}
          </span>
        ) : null}
      </header>

      {runs.length === 0 ? (
        <div className={styles.empty}>
          <EmptyState
            compact
            icon={<Radar size={18} />}
            title={t('orchestration.panel.emptyTitle')}
            description={t('orchestration.panel.emptyDesc')}
          />
        </div>
      ) : (
        <ol className={styles.list}>
          {runs.map((run) => {
            const openable = Boolean(run.terminalId)
            return (
              <li key={run.runId} className={styles.run} data-status={run.status}>
                <div className={styles.runHead}>
                  <AgentIcon type={run.provider} size={14} theme={theme} />
                  <span className={styles.provider}>{AGENT_TYPE_LABELS[run.provider]}</span>
                  <span className={styles.source}>
                    {run.source === 'external_spawn'
                      ? t('orchestration.panel.external')
                      : t('orchestration.panel.internal')}
                  </span>
                  <span className={styles.state}>{t(ORCHESTRATION_STATUS_KEYS[run.status])}</span>
                </div>

                <div className={styles.origin} title={run.origin}>
                  {t('orchestration.origin', { origin: run.origin })}
                </div>
                <div className={styles.jobId}>{run.jobId}</div>

                {run.failureReason ? (
                  <div className={styles.failure}>{run.failureReason}</div>
                ) : null}

                {openable ? (
                  <button
                    type="button"
                    className={styles.open}
                    onClick={() => focusOrchestrationTerminal(run.terminalId as string)}
                  >
                    <TerminalSquare size={11} />
                    {t('orchestration.panel.open')}
                  </button>
                ) : (
                  <div className={styles.noTerminal}>{t('orchestration.panel.noTerminal')}</div>
                )}
              </li>
            )
          })}
        </ol>
      )}

      <footer className={styles.footer}>
        {/* O portão de confirmação é o que impede uma ordem externa de gastar sozinha.
            Desligá-lo é escolha do usuário, e o custo dela fica escrito aqui. */}
        <label className={styles.autoRun}>
          <input
            type="checkbox"
            checked={autoRun}
            onChange={(event) => setPreferences({ externalSpawnAutoRun: event.target.checked })}
          />
          <span>{t('orchestration.pending.autoRun')}</span>
        </label>
        <p className={styles.autoRunHint}>{t('orchestration.pending.autoRunHint')}</p>
        <p className={styles.ephemeral}>{t('orchestration.panel.ephemeral')}</p>
      </footer>
    </section>
  )
}
