import { describe, expect, it } from 'vitest'

import {
  CURSOR_USAGE_DASHBOARD_URL,
  cursorAvailabilityCopy,
  cursorCardForbidsUsageMeter,
  resolveCursorProcessState,
} from './cursorAvailability'
import type { CursorCliStatus } from './tauri'
import type { Project } from './types'

function projectWithCursorPty(ptyId: string | null): Project {
  return {
    id: 'p1',
    name: 'demo',
    color: '#000',
    terminals: [
      {
        id: 't1',
        name: 'Cursor',
        cwd: 'C:\\demo',
        activeTabId: 'tab1',
        disabled: false,
        laneVisible: null,
        tabs: [
          {
            id: 'tab1',
            type: 'cursor',
            name: 'Cursor',
            cwd: 'C:\\demo',
            ptyId,
          },
        ],
      },
    ],
  } as Project
}

describe('cursorAvailability', () => {
  // Lord F1:
  it('resolves real process state from alive PTYs only', () => {
    expect(resolveCursorProcessState([projectWithCursorPty(null)], {})).toBe('stopped')
    expect(resolveCursorProcessState([projectWithCursorPty('pty-1')], {})).toBe('stopped')
    expect(
      resolveCursorProcessState([projectWithCursorPty('pty-1')], { 'pty-1': { alive: true } }),
    ).toBe('running')
  })

  // Lord F1:
  it('covers installed/authenticated, installed/unauthenticated and absent fixtures', () => {
    const ready: CursorCliStatus = {
      status: 'ready',
      cli_path: 'C:\\cursor-agent.cmd',
      authenticated: true,
      email: 'a@b.c',
    }
    const noAuth: CursorCliStatus = {
      status: 'no_auth',
      cli_path: 'C:\\cursor-agent.cmd',
      authenticated: false,
      email: null,
    }
    const absent: CursorCliStatus = {
      status: 'no_cli',
      cli_path: '',
      authenticated: false,
      email: null,
    }

    expect(cursorAvailabilityCopy(ready).pill).toContain('CLI connected')
    expect(cursorAvailabilityCopy(ready).pill).toContain('dashboard')
    expect(cursorAvailabilityCopy(noAuth).title).toMatch(/not signed in/i)
    expect(cursorAvailabilityCopy(absent).title).toMatch(/not installed/i)

    for (const copy of [
      cursorAvailabilityCopy(ready),
      cursorAvailabilityCopy(noAuth),
      cursorAvailabilityCopy(absent),
    ]) {
      const blob = `${copy.pill}\n${copy.title}\n${copy.hint}`
      expect(cursorCardForbidsUsageMeter(blob)).toBe(true)
      expect(blob).not.toMatch(/%/)
    }
  })

  // Lord F1:
  it('rejects any card markup that sneaks in % or a progressbar', () => {
    expect(cursorCardForbidsUsageMeter('<div>CLI connected</div>')).toBe(true)
    expect(cursorCardForbidsUsageMeter('<div>42%</div>')).toBe(false)
    expect(cursorCardForbidsUsageMeter('<div role="progressbar"></div>')).toBe(false)
    expect(CURSOR_USAGE_DASHBOARD_URL).toContain('cursor.com')
  })
})
