import { invoke } from '@tauri-apps/api/core'

import { findCliLauncher } from './misc'

/** Lord F1: disponibilidade do Cursor CLI — sem %, tokens ou custo. */
export type CursorCliStatus = {
  status: 'ready' | 'no_cli' | 'no_auth' | 'unavailable'
  cli_path: string
  authenticated: boolean
  email: string | null
}

/**
 * Lord F1: tenta o comando dedicado; se ainda não estiver registrado em
 * `lib.rs` (bloqueado pelo trabalho paralelo do `/spawn`), degrada para
 * `find_cli_launcher` — instalado vs ausente, sem afirmar autenticação.
 */
export async function getCursorCliStatus(): Promise<CursorCliStatus> {
  try {
    const result = await invoke<CursorCliStatus>('get_cursor_cli_status')
    return {
      status: result.status,
      cli_path: result.cli_path ?? '',
      authenticated: Boolean(result.authenticated),
      email: result.email ?? null,
    }
  } catch {
    const path =
      (await findCliLauncher('cursor-agent').catch(() => null)) ??
      (await findCliLauncher('agent').catch(() => null))
    if (!path) {
      return { status: 'no_cli', cli_path: '', authenticated: false, email: null }
    }
    // Sem o comando registrado não dá pra afirmar auth — não inventa.
    return {
      status: 'unavailable',
      cli_path: path,
      authenticated: false,
      email: null,
    }
  }
}
