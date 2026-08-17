import { Eye, GitBranch, TerminalSquare } from 'lucide-react'

import { useT } from '../../lib/i18n'
import {
  isOrchestrationRunFinished,
  ORCHESTRATION_STATUS_KEYS as STATUS_KEYS,
} from '../../lib/orchestration'
import type { OrchestrationRun } from '../../lib/orchestration'
import type { OrchestrationMode } from '../../lib/types'
import styles from './OrchestrationActivity.module.css'

export type OrchestrationActivityProps = {
  mode: OrchestrationMode
  run?: OrchestrationRun
  /** Lord: subagentes ainda em curso. Run de processo encerrado entra em `finishedCount`. */
  internalRuns: OrchestrationRun[]
  /** Lord: quantos subagentes deste terminal já tiveram o processo encerrado. */
  finishedCount?: number
  currentTerminalId: string
  onFocusTerminal: (terminalId: string) => void
  /** Lord: abre a aba "Agentes" da barra direita, onde a lista completa vive. */
  onOpenFinishedList?: () => void
}

// Lord F3: Projeção visual de processo; nenhum estado recebe semântica de aprovação.
export function OrchestrationActivity({
  mode,
  run,
  internalRuns,
  finishedCount = 0,
  currentTerminalId,
  onFocusTerminal,
  onOpenFinishedList,
}: OrchestrationActivityProps) {
  const t = useT()
  // Lord: cartão inline só para quem ainda está em curso. Um <article> por run
  // encerrada (com <pre> de transcript) fazia a faixa crescer sem limite e
  // espremer a área do terminal a zero — o histórico completo está na aba
  // "Agentes" da barra direita, que tem rolagem própria. Filtro repetido aqui de
  // propósito: o componente não depende de o chamador ter separado as listas.
  const liveRuns = internalRuns.filter((internal) => !isOrchestrationRunFinished(internal.status))
  const finishedTotal = finishedCount + (internalRuns.length - liveRuns.length)
  if (!run && liveRuns.length === 0 && finishedTotal === 0) return null

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

      {liveRuns.map((internal) => (
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

      {/* Lord: uma linha, não um cartão por run. Diz quantos processos encerraram
          e aponta para a aba "Agentes", que é quem lista tudo com rolagem própria.
          "Encerrado" é fato de processo (ADR-0008), não veredito sobre o trabalho. */}
      {finishedTotal > 0 ? (
        onOpenFinishedList ? (
          <button
            type="button"
            className={styles.finished}
            onClick={onOpenFinishedList}
            title={t('orchestration.activity.finishedHint')}
            aria-label={t('orchestration.activity.finishedHint')}
          >
            {t('orchestration.activity.finished', { count: finishedTotal })}
          </button>
        ) : (
          <div
            className={styles.finished}
            title={t('orchestration.activity.finishedHint')}
            aria-label={t('orchestration.activity.finishedHint')}
          >
            {t('orchestration.activity.finished', { count: finishedTotal })}
          </div>
        )
      ) : null}
    </div>
  )
}
