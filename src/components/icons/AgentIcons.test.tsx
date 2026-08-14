import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AgentIcon, CursorIcon } from './AgentIcons'

describe('AgentIcon cursor', () => {
  // Lord F1:
  it('renders the Cursor mark instead of falling back to OpenCode', () => {
    const cursor = renderToStaticMarkup(createElement(CursorIcon, { size: 16 }))
    const viaDispatcher = renderToStaticMarkup(
      createElement(AgentIcon, { type: 'cursor', size: 16, theme: 'dark' }),
    )
    expect(cursor).toContain('svg')
    expect(viaDispatcher).toBe(cursor)
    expect(viaDispatcher).not.toContain('open')
    expect(viaDispatcher).not.toContain('.png')
  })
})
