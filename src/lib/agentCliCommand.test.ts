import { describe, expect, it } from 'vitest'

import { agentCliCommand } from './types'

describe('agentCliCommand', () => {
  it('maps domain agent types to real CLI binaries', () => {
    expect(agentCliCommand('shell')).toBeUndefined()
    expect(agentCliCommand('claude')).toBe('claude')
    expect(agentCliCommand('antigravity')).toBe('agy')
    // Lord F1:
    expect(agentCliCommand('cursor')).toBe('cursor-agent')
  })
})
