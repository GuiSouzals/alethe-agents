import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES, EMPTY_PROJECTS_FILE } from '../lib/types'
import { makeDefaultTerminal } from '../lib/terminalFactory'
import { migrate, prepareProjectsForPersistence } from './projectsStore.migrations'

// Lord F3: Fixture mínima reaproveitada nas versões persistidas suportadas pelo migrador.
function legacyFixture(version: 2 | 3 | 4 | 5 | 6, mode?: 'solo' | 'team') {
  const terminal = makeDefaultTerminal({
    name: 'Codex',
    cwd: 'C:\\work\\project',
    firstTab: {
      type: 'codex',
      cwd: 'C:\\work\\project',
      initialInput: 'prompt must never persist',
      orchestrationMode: mode,
      orchestrationOrigin: 'lord',
      orchestrationRequestId: 'request-1',
      orchestrationJobId: 'job-1',
    },
  })
  if (mode === undefined)
    delete (terminal.tabs[0] as Partial<(typeof terminal.tabs)[0]>).orchestrationMode
  terminal.tabs[0].sessionId = 'session-preserved'
  return {
    ...structuredClone(EMPTY_PROJECTS_FILE),
    version,
    preferences: { ...structuredClone(DEFAULT_PREFERENCES), orchestrationPresentation: undefined },
    projects: [
      {
        id: 'project-1',
        name: `Fixture v${version}`,
        groupId: null,
        terminals: [terminal],
        layoutMode: 'auto',
        collapsed: false,
        createdAt: 1,
      },
    ],
    ungroupedOrder: ['project-1'],
    activeProjectId: 'project-1',
  }
}

describe('Lord F3 orchestration persistence', () => {
  // Lord F3: A mesma asserção cobre todas as versões exigidas pelo oráculo da Fatia 7.
  it.each([2, 3, 4, 5, 6] as const)('migrates v%s without loss and backfills solo', (version) => {
    const migrated = migrate(legacyFixture(version))
    const tab = migrated.projects[0].terminals[0].tabs[0]

    expect(migrated.version).toBe(6)
    expect(migrated.projects[0].name).toBe(`Fixture v${version}`)
    expect(tab.sessionId).toBe('session-preserved')
    expect(tab.orchestrationMode).toBe('solo')
    expect(tab.initialInput).toBeUndefined()
    expect(migrated.preferences.orchestrationPresentation).toBe('dev')
  })

  it('round-trips team and stable ids while excluding the prompt', () => {
    const migrated = migrate(legacyFixture(6, 'team'))
    const persistedProjects = prepareProjectsForPersistence(migrated.projects)
    const serialized = JSON.stringify({ ...migrated, projects: persistedProjects })
    const loaded = migrate(JSON.parse(serialized))
    const tab = loaded.projects[0].terminals[0].tabs[0]

    expect(serialized).not.toContain('prompt must never persist')
    expect(serialized).not.toContain('initialInput')
    expect(tab.orchestrationMode).toBe('team')
    expect(tab.orchestrationOrigin).toBe('lord')
    expect(tab.orchestrationRequestId).toBe('request-1')
    expect(tab.orchestrationJobId).toBe('job-1')
  })

  it('creates solo by default without changing the executable type', () => {
    const terminal = makeDefaultTerminal({
      name: 'Codex',
      cwd: 'C:\\work',
      firstTab: { type: 'codex', cwd: 'C:\\work' },
    })

    expect(terminal.tabs[0].type).toBe('codex')
    expect(terminal.tabs[0].orchestrationMode).toBe('solo')
  })
})
