/**
 * Lord: guarda de regressão pro bug real descrito no ADR-0013 D3 — a injeção
 * de `runtimesPermitidos` foi fiada só no spawn inicial e no restart pelo
 * botão da própria aba; quatro outros call-sites de `restartPty`
 * (ClaudeHistoryModal, resetLastSession, sidebarMenus, TerminalInspector)
 * ficaram de fora e degradavam pra lista vazia — que pela nossa regra
 * significa "não despacha para ninguém" (ver `SpawnPtyArgs.runtimesPermitidos`
 * em `lib/tauri/pty.ts`).
 *
 * Em vez de testar cada call-site individualmente (a maioria é ação de menu
 * dentro de componente, sem infraestrutura de teste hoje), este teste varre
 * o código-fonte e garante MECANICAMENTE que todo `restartPty({...})` no
 * projeto passa `runtimesPermitidos` — pega qualquer call-site novo que
 * esqueça o campo, não só os quatro corrigidos nesta rodada.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(__dirname, '..')

/** Lista todo arquivo .ts/.tsx sob `dir`, recursivamente, ignorando testes. */
function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue
    files.push(full)
  }
  return files
}

/**
 * Extrai o bloco de argumentos de cada chamada `restartPty(...)` num arquivo,
 * por contagem de parênteses balanceados (suficiente aqui: não há string nem
 * comentário com parênteses desbalanceados nos call-sites reais).
 */
function extractRestartPtyCallBlocks(source: string): string[] {
  const blocks: string[] = []
  const callRegex = /restartPty\(/g
  let match: RegExpExecArray | null
  while ((match = callRegex.exec(source))) {
    const start = match.index
    // Ignora a própria definição em pty.ts (`export async function restartPty(`)
    // e re-exports/imports (`restartPty,` ou `{ restartPty }` sem `(` chamando).
    const before = source.slice(Math.max(0, start - 20), start)
    if (/function\s+$/.test(before)) continue

    let depth = 0
    let i = match.index + 'restartPty('.length - 1 // posição do '(' de abertura
    let end = -1
    for (; i < source.length; i++) {
      const ch = source[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) continue
    blocks.push(source.slice(start, end + 1))
  }
  return blocks
}

describe('restartPty: todo call-site declara o escopo de despacho (ADR-0013 D3)', () => {
  const files = listSourceFiles(SRC_ROOT)
  const callSitesByFile = new Map<string, string[]>()

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('restartPty(')) continue
    const blocks = extractRestartPtyCallBlocks(source)
    if (blocks.length > 0) callSitesByFile.set(relative(SRC_ROOT, file), blocks)
  }

  it('encontrou pelo menos os call-sites conhecidos (a varredura não quebrou)', () => {
    const knownFiles = [
      'components/modals/ClaudeHistoryModal.tsx',
      'components/ProjectSidebar/sidebarMenus.tsx',
      'components/TerminalInspector/index.tsx',
      'components/TerminalPane/index.tsx',
      'lib/resetLastSession.ts',
      'stores/projectsStore.projectSlices.ts',
    ]
    const found = [...callSitesByFile.keys()].map((f) => f.replace(/\\/g, '/'))
    for (const known of knownFiles) {
      expect(found).toContain(known)
    }
  })

  it('toda chamada restartPty({...}) inclui runtimesPermitidos', () => {
    const offenders: string[] = []
    for (const [file, blocks] of callSitesByFile) {
      blocks.forEach((block, idx) => {
        if (!block.includes('runtimesPermitidos')) {
          offenders.push(`${file} (chamada #${idx + 1})`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
