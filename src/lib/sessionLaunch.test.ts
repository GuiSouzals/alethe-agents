import { describe, expect, it } from 'vitest'

import { buildAgentLaunch } from './sessionLaunch'

describe('buildAgentLaunch', () => {
  it('new Claude panes receive distinct deterministic session ids', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    const first = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[0],
    )
    const second = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[1],
    )

    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.args).toEqual(['--session-id', ids[0], '--dangerously-skip-permissions'])
    expect(second.args).toEqual(['--session-id', ids[1], '--dangerously-skip-permissions'])
  })

  it('Claude resumes only the session assigned to its pane', () => {
    const launch = buildAgentLaunch(
      'claude',
      ['--continue', '--resume', 'stale', '--session-id', 'stale-too', '--model', 'sonnet'],
      'pane-session',
    )

    expect(launch.args).toEqual(['--resume', 'pane-session', '--model', 'sonnet'])
    expect(launch.createdSession).toBe(false)
  })

  it('Codex without a known id starts a new chat instead of resuming last', () => {
    const launch = buildAgentLaunch('codex', ['resume', '--last', '--search'])
    expect(launch.args).toEqual(['--search'])
  })

  it('Codex and OpenCode use their pane-specific resume syntax', () => {
    expect(buildAgentLaunch('codex', ['resume', 'old', '--search'], 'codex-pane').args).toEqual([
      'resume',
      'codex-pane',
      '--search',
    ])
    expect(
      buildAgentLaunch('opencode', ['--continue', '--session', 'old', '--model', 'x'], 'open-pane')
        .args,
    ).toEqual(['--session', 'open-pane', '--model', 'x'])
  })

  it('Antigravity keeps agy flags and uses its pane-specific conversation', () => {
    expect(
      buildAgentLaunch(
        'antigravity',
        ['--continue', '--conversation', 'old', '--dangerously-skip-permissions'],
        'agy-pane',
      ).args,
    ).toEqual(['--conversation', 'agy-pane', '--dangerously-skip-permissions'])
  })

  // Lord ADR-0013 D5 (etapa 5): --settings estende pra todo terminal Claude.
  it('injects the hooks --settings path for new and resumed Claude sessions', () => {
    const created = buildAgentLaunch(
      'claude',
      [],
      undefined,
      () => 'new-id',
      undefined,
      'C:\\temp\\alethe-agent-hooks.json',
    )
    expect(created.args).toEqual([
      '--session-id',
      'new-id',
      '--settings',
      'C:\\temp\\alethe-agent-hooks.json',
    ])

    const resumed = buildAgentLaunch(
      'claude',
      [],
      'pane-session',
      undefined,
      undefined,
      'C:\\temp\\alethe-agent-hooks.json',
    )
    expect(resumed.args).toEqual([
      '--resume',
      'pane-session',
      '--settings',
      'C:\\temp\\alethe-agent-hooks.json',
    ])
  })

  it('never injects --settings when the path failed to resolve (best-effort)', () => {
    const launch = buildAgentLaunch('claude', [], undefined, () => 'new-id', undefined, undefined)
    expect(launch.args).toEqual(['--session-id', 'new-id'])
  })

  it("does not duplicate --settings when the tab already declares its own", () => {
    const launch = buildAgentLaunch(
      'claude',
      ['--settings', '/user/own-settings.json'],
      undefined,
      () => 'new-id',
      undefined,
      'C:\\temp\\alethe-agent-hooks.json',
    )
    expect(launch.args).toEqual(['--session-id', 'new-id', '--settings', '/user/own-settings.json'])
  })

  // Lord F1:
  it('Cursor launches with base args only and ignores unknown session ids for now', () => {
    expect(buildAgentLaunch('cursor', ['--model', 'auto'], 'chat-id').args).toEqual([
      '--model',
      'auto',
    ])
    expect(buildAgentLaunch('cursor', [], 'chat-id').sessionId).toBeUndefined()
    expect(buildAgentLaunch('cursor', []).createdSession).toBe(false)
  })
})
