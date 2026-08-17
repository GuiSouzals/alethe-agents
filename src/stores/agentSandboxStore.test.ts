import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SandboxNodeStatus } from './agentSandboxStore'

// Lord ADR-0013 D5: pré-requisito de renomeação antes de religar o
// AgentSandbox a uma fonte nova. "done"/"error" liam como estado de
// QUALIDADE ("pronto", "deu certo") quando na verdade só descrevem que o
// PROCESSO parou -- ninguém julgou o trabalho. Renomeado para
// "exited"/"failed", o mesmo vocabulário que `lib/orchestration.ts` já usa
// pro problema idêntico (`process_exited`/`failed`).
describe('AgentSandbox: rótulos de estado nunca confundem processo com qualidade', () => {
  it('SandboxNodeStatus aceita os rótulos de processo renomeados', () => {
    const values: SandboxNodeStatus[] = ['starting', 'idle', 'working', 'exited', 'failed']
    expect(values).toHaveLength(5)
  })

  it('o código-fonte não usa mais os literais "done"/"error" como status do sandbox', () => {
    const storeSource = readFileSync(
      join(__dirname, 'agentSandboxStore.ts'),
      'utf8',
    )
    const componentSource = readFileSync(
      join(__dirname, '..', 'components', 'AgentSandbox', 'index.tsx'),
      'utf8',
    )

    for (const source of [storeSource, componentSource]) {
      expect(source).not.toMatch(/status:\s*'done'/)
      expect(source).not.toMatch(/status:\s*'error'/)
      expect(source).not.toMatch(/case 'done'/)
      expect(source).not.toMatch(/case 'error'/)
    }
  })

  it('a folha de estilo não referencia mais os tokens de cor fantasma (--status-success/--status-error nunca existiram em nenhum tema)', () => {
    const cssSource = readFileSync(
      join(__dirname, '..', 'components', 'AgentSandbox', 'AgentSandbox.module.css'),
      'utf8',
    )
    // .dangerButton (botão, não rótulo de estado) fica de fora de propósito:
    // é um problema pré-existente separado, fora do escopo desta renomeação.
    expect(cssSource).not.toContain('.status_done')
    expect(cssSource).not.toContain('.status_error')
    // `var(--status-success)` nunca existiu em nenhum tema (só o USO real
    // importa aqui -- o nome do token ainda aparece no comentário acima que
    // documenta a correção, e isso é esperado).
    expect(cssSource).not.toContain('var(--status-success)')
  })
})
