import { CircleCheck, Folder, Info, ShieldCheck, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useUiStore } from '../../stores/uiStore'
import { basename } from '../../lib/paths'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import { pickDirectory } from '../../lib/dialog'
import { AGENT_TYPE_LABELS, ALL_AGENT_TYPES, UNRESTRICTED_FLAG, type AgentRuntimeProfile, type AgentType } from '../../lib/types'
import { AgentIcon } from '../icons/AgentIcons'
import { buildSpawnBridgeArgs } from '../../lib/spawnBridge'
import { useT } from '../../lib/i18n'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './NewTerminalModal.module.css'

const AGENTS: { type: AgentType; label: string }[] = ALL_AGENT_TYPES.map((type) => ({
  type,
  label: AGENT_TYPE_LABELS[type],
}))

export function NewTerminalModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'newTerminal')
  const context = useUiStore((s) => s.modalContext) as { projectId?: string } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const createAgentTerminal = useProjectsStore((s) => s.createAgentTerminal)
  const alwaysStartUnrestricted = useProjectsStore((s) => s.preferences.alwaysStartUnrestricted)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const project = useProjectsStore((s) =>
    context?.projectId ? (s.projects.find((p) => p.id === context.projectId) ?? null) : null,
  )
  const projects = useProjectsStore((s) => s.projects)
  const enabled = useProjectsStore((s) => s.preferences.enabledAgents)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )

  const [type, setType] = useState<AgentType>('claude')
  const [runtimeProfile, setRuntimeProfile] = useState<AgentRuntimeProfile>('lean')
  const [cwd, setCwd] = useState('')
  const [unrestricted, setUnrestricted] = useState<Record<AgentType, boolean>>(() =>
    Object.fromEntries(ALL_AGENT_TYPES.map((agent) => [agent, false])) as Record<AgentType, boolean>,
  )
  // Lord ADR-0013 D2: default restritivo — só o próprio tipo vem marcado.
  // Reseta quando o tipo do terminal muda (trocar de Claude pra Codex, por
  // exemplo, não deveria carregar uma seleção pensada pro tipo anterior).
  const [runtimesPermitidos, setRuntimesPermitidos] = useState<AgentType[]>([type])
  // Lord: portão de gasto por terminal, decidido aqui junto do alcance de
  // despacho porque é o mesmo assunto. Nasce LIGADO — desligar é escolha
  // explícita e vale só para este terminal, nunca para todos como fazia a
  // preferência global `externalSpawnAutoRun`.
  const [exigeConfirmacaoDeGasto, setExigeConfirmacaoDeGasto] = useState(true)

  const visibleAgents = AGENTS.filter((a) => enabled[a.type])
  const defaultType =
    visibleAgents.find((agent) => agent.type === 'claude')?.type ??
    visibleAgents[0]?.type ??
    'shell'
  const selectedAgent = AGENTS.find((agent) => agent.type === type) ?? AGENTS[0]
  const inheritedCwd = useMemo(() => getProjectDefaultCwd(project, projects), [project, projects])
  const recentFolders = useMemo(() => {
    const folders = new Map<string, { path: string; lastUsedAt: number }>()
    for (const candidate of projects) {
      for (const terminal of candidate.terminals) {
        const paths = [terminal.cwd, ...terminal.tabs.map((tab) => tab.cwd)]
        for (const path of paths) {
          const trimmed = path?.trim()
          if (!trimmed) continue
          const key = trimmed.replace(/[\\/]+$/, '').toLowerCase()
          const lastUsedAt = terminal.lastUsedAt ?? 0
          const previous = folders.get(key)
          if (!previous || lastUsedAt > previous.lastUsedAt) {
            folders.set(key, { path: trimmed, lastUsedAt })
          }
        }
      }
    }
    return [...folders.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 4)
  }, [projects])

  useEffect(() => {
    if (!open) return
    setCwd(inheritedCwd)
    setType(defaultType)
    setRuntimesPermitidos([defaultType])
    // Lord: cada abertura do modal volta ao portão ligado — a escolha de um
    // terminal anterior não vaza para o próximo.
    setExigeConfirmacaoDeGasto(true)
    // Lord F1: inclui cursor via ALL_AGENT_TYPES.
    setUnrestricted(
      Object.fromEntries(
        ALL_AGENT_TYPES.map((agent) => [agent, alwaysStartUnrestricted]),
      ) as Record<AgentType, boolean>,
    )
  }, [open, context?.projectId, inheritedCwd, defaultType, alwaysStartUnrestricted])

  // Lord ADR-0013 D2: trocar o tipo do terminal reseta o conjunto pro novo
  // próprio tipo — evita carregar uma seleção pensada pro tipo anterior sem
  // o usuário notar.
  const selectType = (next: AgentType) => {
    setType(next)
    setRuntimesPermitidos([next])
  }

  const toggleRuntimePermitido = (agent: AgentType) => {
    setRuntimesPermitidos((current) =>
      current.includes(agent) ? current.filter((item) => item !== agent) : [...current, agent],
    )
  }

  const reset = () => {
    setType(defaultType)
    setRuntimeProfile('lean')
    setCwd('')
    setRuntimesPermitidos([defaultType])
    setExigeConfirmacaoDeGasto(true)
    setUnrestricted({
      shell: false,
      claude: false,
      codex: false,
      antigravity: false,
      cursor: false,
      opencode: false,
      freebuff: false,
      mimo: false,
    })
  }

  const submit = async () => {
    if (!context?.projectId) return
    const finalName = selectedAgent.label
    const finalCwd = cwd.trim() || inheritedCwd
    const flag = UNRESTRICTED_FLAG[type]
    // Lord: a flag de modo irrestrito e a ponte de despacho são independentes —
    // compõem, não competem. Marcar 2+ runtimes não pode apagar o irrestrito.
    const composedArgs = [
      ...(unrestricted[type] && flag ? [flag] : []),
      ...buildSpawnBridgeArgs(type, runtimesPermitidos),
    ]
    const extraArgs = composedArgs.length > 0 ? composedArgs : undefined
    await createAgentTerminal(context.projectId, {
      name: finalName,
      cwd: finalCwd,
      firstTab: {
        type,
        cwd: finalCwd,
        extraArgs,
        runtimeProfile,
        runtimesPermitidos,
        // Lord: o portão de gasto viaja junto do alcance — as duas escolhas da
        // seção 3 vão gravadas na aba, não numa preferência global.
        exigeConfirmacaoDeGasto,
      },
    })
    reset()
    closeModal()
  }

  const browse = async () => {
    const dir = await pickDirectory({ defaultPath: cwd || inheritedCwd || undefined })
    if (dir) setCwd(dir)
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        closeModal()
      }}
      title={t('term.newTerminalTitle')}
      width={560}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('term.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => void submit()}
            disabled={!context?.projectId}
          >
            {t('term.openAgent', { agent: selectedAgent.label })}
          </button>
        </>
      }
    >
      <p className={styles.description}>{t('term.newTerminalDescription')}</p>

      <section className={styles.section}>
        <h3 className={styles.stepTitle}>{t('term.stepTerminal')}</h3>
        <div className={styles.agentGrid}>
          {visibleAgents.map((a) => {
            const active = type === a.type
            return (
              <button
                key={a.type}
                type="button"
                className={`${styles.agentCard} ${active ? styles.agentCardActive : ''}`}
                onClick={() => selectType(a.type)}
                aria-pressed={active}
              >
                <span className={styles.agentIcon}>
                  <AgentIcon type={a.type} size={22} theme={terminalTheme} />
                </span>
                <span className={styles.agentLabel}>{a.label}</span>
                {active ? <CircleCheck size={17} className={styles.selectedIcon} /> : null}
              </button>
            )
          })}
        </div>
        {UNRESTRICTED_FLAG[type] ? (
          <button
            type="button"
            className={`${styles.permissionToggle} ${unrestricted[type] ? styles.permissionToggleActive : ''}`}
            onClick={() => setUnrestricted((value) => ({ ...value, [type]: !value[type] }))}
            aria-pressed={unrestricted[type]}
          >
            <span className={styles.permissionToggleIcon}>
              <Zap size={17} />
            </span>
            <span className={styles.permissionToggleCopy}>
              <span className={styles.permissionToggleTitle}>{t('term.unrestrictedShort')}</span>
              <span className={styles.permissionToggleDescription}>
                {t('term.unrestrictedDescription')}
              </span>
            </span>
            <span className={styles.permissionToggleState}>
              {unrestricted[type] ? t('term.unrestrictedOn') : t('term.unrestrictedOff')}
            </span>
          </button>
        ) : null}
        {UNRESTRICTED_FLAG[type] ? (
          <label className={styles.alwaysUnrestricted}>
            <input
              type="checkbox"
              checked={alwaysStartUnrestricted}
              onChange={(event) =>
                setPreferences({ alwaysStartUnrestricted: event.target.checked })
              }
            />
            <span>{t('term.alwaysUnrestricted')}</span>
          </label>
        ) : null}
      </section>

      <section className={styles.section}>
        <h3 className={styles.stepTitle}>{t('term.stepFolder')}</h3>
        <div className={styles.folderRow}>
          <Folder size={16} className={styles.folderIcon} />
          <input
            className={styles.folderInput}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={inheritedCwd || t('term.shellDefaultPlaceholder')}
          />
          <button type="button" className={styles.browseButton} onClick={browse}>
            {t('term.browse')}
          </button>
        </div>

        {recentFolders.length > 0 ? (
          <div className={styles.recentBlock}>
            <span className={styles.recentLabel}>{t('term.recentFolders')}</span>
            <div className={styles.recentFolders}>
              {recentFolders.map((folder) => {
                const label = basename(folder.path) || folder.path
                return (
                  <button
                    key={folder.path}
                    type="button"
                    className={styles.folderChip}
                    title={folder.path}
                    onClick={() => setCwd(folder.path)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </section>

      <section className={styles.section}>
        <h3 className={styles.stepTitle}>{t('term.stepScope')}</h3>
        <p className={styles.scopeHint}>{t('term.stepScopeHint')}</p>
        <div className={styles.scopeChips}>
          {visibleAgents.map((a) => {
            const checked = runtimesPermitidos.includes(a.type)
            return (
              <button
                key={a.type}
                type="button"
                className={`${styles.scopeChip} ${checked ? styles.scopeChipActive : ''}`}
                onClick={() => toggleRuntimePermitido(a.type)}
                aria-pressed={checked}
              >
                <AgentIcon type={a.type} size={14} theme={terminalTheme} />
                <span>{a.label}</span>
                {checked ? <CircleCheck size={13} /> : null}
              </button>
            )
          })}
        </div>
        {runtimesPermitidos.length === 0 ? (
          <p className={styles.scopeWarning}>{t('term.stepScopeEmptyWarning')}</p>
        ) : null}
        {/* Lord: marcar o segundo runtime deixa de ser só autorização e passa a
            injetar a instrução de despacho. O aviso existe para o usuário saber
            que mudou de comportamento, não só de permissão. */}
        {runtimesPermitidos.length > 1 ? (
          <p className={styles.scopeBridgeNote}>{t('term.stepScopeBridge')}</p>
        ) : null}
        {/* Lord: portão de confirmação de gasto DESTE terminal. Mora nesta seção
            porque decide a mesma coisa que os chips acima — o que o terminal pode
            fazer com o dinheiro do dono. Mesmo componente visual do toggle de
            modo irrestrito, sem inventar controle novo. */}
        <button
          type="button"
          className={`${styles.permissionToggle} ${exigeConfirmacaoDeGasto ? styles.permissionToggleActive : ''}`}
          onClick={() => setExigeConfirmacaoDeGasto((value) => !value)}
          aria-pressed={exigeConfirmacaoDeGasto}
        >
          <span className={styles.permissionToggleIcon}>
            <ShieldCheck size={17} />
          </span>
          <span className={styles.permissionToggleCopy}>
            <span className={styles.permissionToggleTitle}>{t('term.stepScopeConfirm')}</span>
            <span className={styles.permissionToggleDescription}>
              {t('term.stepScopeConfirmHint')}
            </span>
          </span>
          <span className={styles.permissionToggleState}>
            {exigeConfirmacaoDeGasto ? t('term.unrestrictedOn') : t('term.unrestrictedOff')}
          </span>
        </button>
      </section>

      <div className={styles.autoNameHint}>
        <Info size={13} />
        <span>{t('term.autoNameHint')}</span>
      </div>

      {type !== 'shell' ? (
        <details className={styles.advanced}>
          <summary>{t('term.advancedOptions')}</summary>
          <div className={styles.advancedBody}>
            <div className={controls.field}>
              <label className={controls.label}>{t('term.runtimeProfile')}</label>
              <div className={controls.pillRow}>
                {(['full', 'lean', 'diagnostic'] as const).map((profile) => (
                  <button
                    key={profile}
                    type="button"
                    className={`${controls.pill} ${runtimeProfile === profile ? controls.pillActive : ''}`}
                    onClick={() => setRuntimeProfile(profile)}
                    title={t(`term.runtimeProfile.${profile}.desc`)}
                  >
                    {t(`term.runtimeProfile.${profile}`)}
                  </button>
                ))}
              </div>
              <span className={controls.hint}>
                {t(`term.runtimeProfile.${runtimeProfile}.desc`)}
              </span>
            </div>
          </div>
        </details>
      ) : null}
    </Modal>
  )
}
