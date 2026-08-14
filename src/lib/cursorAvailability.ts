import type { CursorCliStatus } from './tauri'
import type { Project } from './types'

/** URL oficial do dashboard de uso do Cursor (consumo não vem do CLI). */
export const CURSOR_USAGE_DASHBOARD_URL = 'https://cursor.com/dashboard'

export type CursorProcessState = 'running' | 'stopped'

/**
 * Lord F1: estado de processo real a partir dos PTYs vivos do tipo cursor.
 * Nunca inventa — sem ptyId vivo = parado.
 */
export function resolveCursorProcessState(
  projects: readonly Project[],
  aliveByPtyId: Readonly<Record<string, { alive?: boolean } | undefined>>,
): CursorProcessState {
  for (const project of projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (tab.type !== 'cursor' || !tab.ptyId) continue
        if (aliveByPtyId[tab.ptyId]?.alive) return 'running'
      }
    }
  }
  return 'stopped'
}

/** Lord F1: textos do card/pill — sem %, barra ou custo. */
export function cursorAvailabilityCopy(status: CursorCliStatus | null): {
  pill: string
  title: string
  hint: string
} {
  if (!status || status.status === 'no_cli') {
    return {
      pill: 'CLI missing',
      title: 'cursor CLI not installed',
      hint: 'install the Cursor CLI to launch sessions from this workspace',
    }
  }
  if (status.status === 'no_auth') {
    return {
      pill: 'CLI · sign in',
      title: 'not signed in to Cursor CLI',
      hint: 'run agent login — usage lives in the Cursor dashboard, not here',
    }
  }
  if (status.status === 'ready') {
    return {
      // D3: pill "CLI conectado · consumo no dashboard"
      pill: 'CLI connected · usage in dashboard',
      title: 'CLI connected · usage in dashboard',
      hint: 'open the Cursor dashboard for the real usage number — this card never invents a percentage',
    }
  }
  // unavailable / CLI found but auth unknown (comando Tauri ainda não registrado)
  return {
    pill: 'CLI found · usage in dashboard',
    title: 'Cursor CLI found',
    hint: 'usage lives in the Cursor dashboard — this card never invents a percentage',
  }
}

/** Lord F1: oráculo — o markup do card Cursor não pode conter % nem progressbar. */
export function cursorCardForbidsUsageMeter(markup: string): boolean {
  if (/%/.test(markup)) return false
  if (/progressbar|role=["']progressbar["']/i.test(markup)) return false
  if (/meter|used_percent|utilization/i.test(markup)) return false
  return true
}
