import { Eye, GitBranch, TerminalSquare } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { ORCHESTRATION_STATUS_KEYS as STATUS_KEYS } from '../../lib/orchestration'
import type { OrchestrationRun } from '../../lib/orchestration'
import type { OrchestrationMode } from '../../lib/types'
import styles from './OrchestrationActivity.module.css'

export type OrchestrationActivityProps = {
  mode: OrchestrationMode
  run?: OrchestrationRun
  internalRuns: OrchestrationRun[]
  currentTerminalId: string
  onFocusTerminal: (terminalId: string) => void
}

// Lord F3: Projeção visual de processo; nenhum estado recebe semântica de aprovação.
export function OrchestrationActivity({
  mode,
  run,
  internalRuns,
  currentTerminalId,
  onFocusTerminal,
}: OrchestrationActivityProps) {
  const t = useT()
  if (!run && internalRuns.length === 0) return null

  return (
    <div className={styles.activity} aria-label={t('orchestration.activity')}>
      {run ? (
        <div className={styles.runBar} data-status={run.status}>
          <span className={styles.mode}>{t(`orchestration.mode.${mode}`)}</span>
          <span className={styles.origin}>{t('orchestration.origin', { origin: run.origin })}</span>
          <span className={styles.state}>{t(STATUS_KEYS[run.status])}</span>
          <span className={styles.navigation}>
            {run.parentTerminalId ? (
              <button type="button" onClick={() => onFocusTerminal(run.parentTerminalId!)}>
                <GitBranch size={11} />
                {t('orchestration.focusParent')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onFocusTerminal(run.terminalId ?? currentTerminalId)}
            >
              <TerminalSquare size={11} />
              {t('orchestration.focusChild')}
            </button>
          </span>
        </div>
      ) : null}

      {internalRuns.map((internal) => (
        <article key={internal.runId} className={styles.internalCard}>
          <div className={styles.internalHeader}>
            <Eye size={12} />
            <strong>{t('orchestration.internal.readOnly')}</strong>
            <span>{t(STATUS_KEYS[internal.status])}</span>
          </div>
          <div className={styles.internalOrigin}>
            {t('orchestration.origin', { origin: internal.origin })}
          </div>
          {internal.liveOutput === 'unavailable' ? (
            <div className={styles.unavailable}>{t('orchestration.internal.noLiveOutput')}</div>
          ) : null}
          {internal.finalTranscript ? (
            <pre className={styles.transcript}>{internal.finalTranscript}</pre>
          ) : internal.status === 'process_exited' ? (
            <div className={styles.unavailable}>{t('orchestration.internal.noTranscript')}</div>
          ) : null}
        </article>
      ))}
    </div>
  )
}
