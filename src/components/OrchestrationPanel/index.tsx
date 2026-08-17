import { Radar, TerminalSquare } from 'lucide-react'
import { useMemo } from 'react'

import { focusOrchestrationTerminal } from '../../hooks/focusOrchestrationTerminal'
import { useT, type MessageKey, type TFunction } from '../../lib/i18n'
import { ORCHESTRATION_STATUS_KEYS, type OrchestrationRun } from '../../lib/orchestration'
import { AGENT_TYPE_LABELS, type Project } from '../../lib/types'
import { useOrchestrationStore } from '../../stores/orchestrationStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import { EmptyState } from '../EmptyState'
import styles from './OrchestrationPanel.module.css'

// Lord: honestidade da verificação de escopo (manutenção pós-ADR-0013, item 2).
// Códigos vêm do Rust (`agent_events.rs::ScopeVisibility::note_code`) e nunca
// são texto de UI — o `t(...)` faz a tradução; um código desconhecido cai no
// aviso genérico em vez de aparecer cru na tela.
const SCOPE_NOTE_KEYS: Record<string, MessageKey> = {
  sem_terminal_origem: 'orchestration.panel.scopeNoteNoOrigin',
  terminal_origem_desconhecido: 'orchestration.panel.scopeNoteUnknownOrigin',
}

// Lord: chave do grupo de execuções sem terminal de origem conhecido. Tem `:` de
// propósito para não colidir com id de terminal (nanoid), que nunca contém `:`.
const NO_ORIGIN_GROUP_KEY = 'grupo:sem-origem'

type RunGroupKind = 'activeTerminal' | 'terminal' | 'noOrigin'

type RunGroup = {
  key: string
  kind: RunGroupKind
  /** Nome real do terminal, lido do `projectsStore`. Só existe em `kind: 'terminal'`. */
  terminalName?: string
  runs: OrchestrationRun[]
}

// Lord: decide de qual terminal a execução é. `parentTerminalId` (quem despachou)
// manda quando existe, por dois motivos: para `internal_subagent` é o ÚNICO vínculo
// possível, porque o subagente não abre aba própria (mesmo critério que o
// TerminalPane já usa na faixa de atividade, `TerminalPane/index.tsx:239`); e para
// `external_spawn` é o terminal que PEDIU, que é justamente a pergunta que o
// agrupamento responde. `terminalId` (a aba criada pelo despacho) entra só como
// segunda tentativa — cobre a ordem externa sem `parentTerminalId`, que senão cairia
// em "sem origem" mesmo tendo aberto uma aba visível no projeto ativo.
function runOriginCandidates(run: OrchestrationRun): string[] {
  return [run.parentTerminalId, run.terminalId].filter((id): id is string => Boolean(id))
}

// Lord: `parentTerminalId` carrega DUAS identidades diferentes, dependendo de quem
// escreveu o evento — e sem traduzir uma delas o agrupamento acerta por acidente,
// pelo motivo errado:
//
// - subagente interno grava `Terminal.id` (`useInternalSubagentProjection.ts`, via
//   `findUniqueTerminalForSession`);
// - ordem externa grava o `ptyId` da aba que pediu — é o único id que o processo
//   conhece de si mesmo, injetado como `LORD_TERMINAL_ID` (ver o comentário em
//   `src-tauri/src/agent_events.rs`, em `extract_runtimes_permitidos`).
//
// Sem esta tradução, o `parentTerminalId` de uma ordem externa nunca casa com
// `Terminal.id`, o casamento cai no `terminalId` de reserva, e a execução aparece
// agrupada sob a aba que ela CRIOU em vez do terminal que a PEDIU. Este mapa
// resolve ptyId -> Terminal.id para que as duas origens respondam à mesma pergunta.
function terminalIdByPtyId(projects: Project[]): Map<string, string> {
  const byPtyId = new Map<string, string>()
  for (const project of projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (tab.ptyId) byPtyId.set(tab.ptyId, terminal.id)
      }
    }
  }
  return byPtyId
}

// Lord: agrupa em vez de filtrar. Filtrar pelo terminal ativo devolveria a cegueira
// descrita no comentário do componente; o agrupamento dá a leitura por terminal sem
// tirar da tela nada que pertença ao projeto ativo — inclusive ordem externa sem
// terminal de origem. Execução de outro projeto vira só CONTAGEM: a lista dela está
// na sessão do projeto dela, e quem quer o detalhe troca de projeto.
function groupRunsByOriginTerminal(
  runs: OrchestrationRun[],
  projects: Project[],
  activeProjectId: string | null,
  activeTerminalId: string | null,
): { groups: RunGroup[]; otherProjectsCount: number } {
  const activeProject = activeProjectId
    ? (projects.find((project) => project.id === activeProjectId) ?? null)
    : null
  const activeTerminalIds = new Set((activeProject?.terminals ?? []).map((terminal) => terminal.id))
  const knownTerminalIds = new Set(
    projects.flatMap((project) => project.terminals.map((terminal) => terminal.id)),
  )
  const byPtyId = terminalIdByPtyId(projects)

  const runsByTerminal = new Map<string, OrchestrationRun[]>()
  const noOrigin: OrchestrationRun[] = []
  let otherProjectsCount = 0

  for (const run of runs) {
    // Traduz ptyId -> Terminal.id antes de casar, para as duas identidades de
    // `parentTerminalId` chegarem na mesma moeda (ver `terminalIdByPtyId`).
    const candidates = runOriginCandidates(run).map((id) => byPtyId.get(id) ?? id)
    const owner = candidates.find((id) => activeTerminalIds.has(id))
    if (owner) {
      const bucket = runsByTerminal.get(owner)
      if (bucket) bucket.push(run)
      else runsByTerminal.set(owner, [run])
      continue
    }
    if (candidates.some((id) => knownTerminalIds.has(id))) {
      otherProjectsCount += 1
      continue
    }
    noOrigin.push(run)
  }

  const groups: RunGroup[] = []
  const activeTerminalRuns = activeTerminalId ? runsByTerminal.get(activeTerminalId) : undefined
  if (activeTerminalId && activeTerminalRuns) {
    groups.push({ key: activeTerminalId, kind: 'activeTerminal', runs: activeTerminalRuns })
  }
  // A ordem dos demais grupos é a ordem dos terminais no projeto — a mesma da árvore
  // lateral. Ordenar por recência faria o painel remexer sozinho a cada evento.
  for (const terminal of activeProject?.terminals ?? []) {
    if (terminal.id === activeTerminalId) continue
    const terminalRuns = runsByTerminal.get(terminal.id)
    if (!terminalRuns) continue
    groups.push({
      key: terminal.id,
      kind: 'terminal',
      terminalName: terminal.name,
      runs: terminalRuns,
    })
  }
  if (noOrigin.length > 0) {
    groups.push({ key: NO_ORIGIN_GROUP_KEY, kind: 'noOrigin', runs: noOrigin })
  }

  return { groups, otherProjectsCount }
}

// Lord: rótulo do cabeçalho. Grupo de terminal usa o nome real que já existe no
// `projectsStore`; os dois grupos sintéticos usam chave de i18n já existente.
// Nenhum rótulo é inventado aqui, e nenhum descreve aprovação (ADR-0008).
function groupHeaderLabel(group: RunGroup, t: TFunction): string {
  if (group.kind === 'activeTerminal') return t('orchestration.panel.groupThisTerminal')
  if (group.kind === 'noOrigin') return t('orchestration.panel.groupNoOrigin')
  return group.terminalName ?? ''
}

// Lord: até aqui, um agente despachado só era visível dentro do painel do terminal que
// ele mesmo criou. Quem estava noutro projeto ou com o grupo recolhido não via nada.
// Esta é a única superfície que lista todas as execuções sem filtrar por terminal.
export function OrchestrationPanel() {
  const t = useT()
  const runsById = useOrchestrationStore((state) => state.runsById)
  const runOrder = useOrchestrationStore((state) => state.runOrder)
  const theme = useProjectsStore((state) => state.preferences.uiTheme)
  const projects = useProjectsStore((state) => state.projects)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const focusedTerminalId = useProjectsStore((state) => state.workspace.focusedTerminalId)
  const activeTerminalRef = useUiStore((state) => state.activeTerminal)

  // Mais recente primeiro: runOrder é ordem de inserção, append-only.
  const runs = useMemo(
    () =>
      runOrder
        .map((runId) => runsById[runId])
        .filter((run): run is NonNullable<typeof run> => Boolean(run))
        .reverse(),
    [runOrder, runsById],
  )

  // Lord: terminal ativo derivado só de estado que já existe — `uiStore.activeTerminal`
  // (o pane que recebeu foco) com fallback em `workspace.focusedTerminalId`, o mesmo par
  // que `useKeybindings.ts:188-189` usa. O `activeTerminal` carrega o projeto de origem e
  // pode estar apontando para um projeto que não é o exibido; nesse caso ele não vale, e
  // um id que não existe mais no projeto ativo também não.
  const activeTerminalId = useMemo(() => {
    const activeProject = projects.find((project) => project.id === activeProjectId)
    if (!activeProject) return null
    const candidate =
      activeTerminalRef?.projectId === activeProjectId
        ? activeTerminalRef.terminalId
        : focusedTerminalId
    if (!candidate) return null
    return activeProject.terminals.some((terminal) => terminal.id === candidate) ? candidate : null
  }, [activeProjectId, activeTerminalRef, focusedTerminalId, projects])

  const { groups, otherProjectsCount } = useMemo(
    () => groupRunsByOriginTerminal(runs, projects, activeProjectId, activeTerminalId),
    [activeProjectId, activeTerminalId, projects, runs],
  )

  return (
    <section className={styles.panel} aria-label={t('orchestration.panel.title')}>
      <header className={styles.header}>
        <Radar size={15} />
        <span className={styles.headerTitle}>{t('orchestration.panel.title')}</span>
        {/* A contagem é da SESSÃO inteira, não do grupo: é a única superfície que diz
            quanto rodou no app todo. Agrupar não pode reduzir esse número. */}
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
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.key} className={styles.group}>
              <h3 className={styles.groupHeader}>{groupHeaderLabel(group, t)}</h3>
              <ol className={styles.groupRuns}>
                {group.runs.map((run) => {
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
                        <span className={styles.state}>
                          {t(ORCHESTRATION_STATUS_KEYS[run.status])}
                        </span>
                      </div>

                      <div className={styles.origin} title={run.origin}>
                        {t('orchestration.origin', { origin: run.origin })}
                      </div>
                      <div className={styles.jobId}>{run.jobId}</div>

                      {run.failureReason ? (
                        <div className={styles.failure}>{run.failureReason}</div>
                      ) : null}

                      {run.scopeNote ? (
                        <div
                          className={styles.scopeNote}
                          title={t('orchestration.panel.scopeNoteHint')}
                        >
                          {t(
                            SCOPE_NOTE_KEYS[run.scopeNote] ??
                              'orchestration.panel.scopeNoteUnknown',
                          )}
                        </div>
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
                        <div className={styles.noTerminal}>
                          {t('orchestration.panel.noTerminal')}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
            </div>
          ))}

          {/* Só a contagem: a lista de outro projeto pertence à tela daquele projeto. */}
          {otherProjectsCount > 0 ? (
            <p className={styles.otherProjects}>
              {t('orchestration.panel.otherProjects', { count: String(otherProjectsCount) })}
            </p>
          ) : null}
        </div>
      )}

      <footer className={styles.footer}>
        {/* Lord: aqui existia a caixa "executar ordens externas sem perguntar", que
            desligava o portão de confirmação de gasto do app INTEIRO. Removida: um
            interruptor global escondido no rodapé de um painel é o pior lugar para
            uma decisão sobre dinheiro — ligá-lo para uma cadeia automática
            desligava a confirmação de todo terminal aberto, inclusive os
            esquecidos. A decisão passou a ser POR TERMINAL, escolhida no modal de
            novo terminal junto do alcance de despacho, porque é o mesmo assunto
            (ver `SubTab.exigeConfirmacaoDeGasto` e `lib/spawnConfirmation.ts`). */}
        <p className={styles.ephemeral}>{t('orchestration.panel.ephemeral')}</p>
      </footer>
    </section>
  )
}
