import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { agentHooksEndpoint, agentHooksSettingsPath, agentHooksToken, codexAppServerSend, codexAppServerStop, killPty, listenPtyExit, spawnPty, writePty } from '../lib/tauri'

export type SandboxNodeStatus = 'starting' | 'idle' | 'working' | 'done' | 'error'

export type SandboxNode = {
  id: string
  label: string
  role: string
  command: 'shell' | 'claude' | 'codex' | 'opencode'
  extraArgs?: string[]
  initialInput?: string
  cwd?: string
  ptyId: string | null
  appServerId?: string
  jobId?: string
  threadId?: string
  turnId?: string
  transport?: 'pty' | 'app-server'
  parentId?: string
  status: SandboxNodeStatus
  x: number
  y: number
  width: number
  height: number
  color: string
  lastMessage: string | null
  output?: string
  managed?: boolean
}

export type SandboxGroup = {
  id: string
  label: string
  nodeIds: string[]
}

export type SandboxMessage = {
  id: string
  from: string
  to: string
  text: string
  createdAt: number
  state: 'sending' | 'delivered'
}

type AgentSandboxState = {
  active: boolean
  cwd: string | null
  nodes: SandboxNode[]
  messages: SandboxMessage[]
  groups: SandboxGroup[]
  runningDemo: boolean
  startDemo: (cwd: string) => Promise<void>
  stop: () => void
  moveNode: (id: string, x: number, y: number) => void
  resizeNode: (id: string, width: number, height: number) => void
  clearInitialInput: (id: string) => void
  sendMessage: (from: string, to: string, text: string) => Promise<void>
  syncProjectTerminals: (terminals: Array<{ id: string; label: string; command: SandboxNode['command']; ptyId: string | null; cwd: string }>) => void
  groupNodes: (nodeIds: string[]) => void
  ungroupNodes: (groupId: string) => void
}

const SPAWN_BRIDGE_PROMPT = `You are the Planner Claude inside Alethe. You are the parent orchestrator. When the user asks you to delegate work, create a real Codex worker through Alethe's local bridge instead of doing the work yourself. Use a short self-contained task and include parent_id='lead'. Example: $body=@{agent='codex';task='Create worker-proof.txt containing READY';cwd=(pwd).Path;parent_id='lead'}|ConvertTo-Json -Compress; Invoke-RestMethod "$env:ALETHE_AGENT_HOOKS_ENDPOINT/spawn" -Method Post -Headers @{'X-Alethe-Token'=$env:ALETHE_AGENT_HOOKS_TOKEN} -ContentType 'application/json' -Body $body. Keep task under 300 characters. Alethe injects the worker's completed response back into your terminal, so review it and send follow-up work through the same bridge or composer. Never claim a worker completed work until its response arrives. If a worker exists, do not perform its delegated task yourself or edit its files.`

const DEMO_NODES: Omit<SandboxNode, 'ptyId' | 'status' | 'lastMessage'>[] = [
  { id: 'lead', label: 'Planner Claude · Haiku · YOLO', role: 'planner', command: 'claude', extraArgs: ['--model', 'haiku', '--dangerously-skip-permissions', '--append-system-prompt', SPAWN_BRIDGE_PROMPT], x: 90, y: 24, width: 420, height: 300, color: 'var(--agent-claude)' },
]

const exitCleanups = new Map<string, () => void>()
const outputCleanups = new Map<string, () => void>()
const appServerCleanups = new Map<string, () => void>()
let hookEventCleanup: UnlistenFn | null = null
let sandboxGeneration = 0

function normalizeSandboxPath(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

function shellLine(text: string): string {
  const safeText = text.replace(/[\r\n]+/g, ' ').replace(/'/g, "''")
  return `Write-Output '[sandbox] ${safeText}'\r`
}

function hookSummary(payload: Record<string, unknown>): string {
  const eventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'agent event'
  const tool = typeof payload.tool_name === 'string' ? ` ${payload.tool_name}` : ''
  const detailSource = payload.tool_response ?? payload.tool_input ?? payload.message
  const detail = typeof detailSource === 'string'
    ? detailSource
    : detailSource && typeof detailSource === 'object'
      ? JSON.stringify(detailSource)
      : ''
  return `[Alethe hook] ${eventName}${tool}${detail ? `: ${detail.replace(/[\r\n]+/g, ' ').slice(0, 420)}` : ''}`
}

async function writeAgentMessage(ptyId: string, text: string): Promise<void> {
  const open = '\x1b[200~'
  const close = '\x1b[201~'
  const chunkSize = 900
  await writePty(ptyId, open)
  for (let index = 0; index < text.length; index += chunkSize) {
    await writePty(ptyId, text.slice(index, index + chunkSize))
    await new Promise((resolve) => window.setTimeout(resolve, 8))
  }
  await writePty(ptyId, `${close}\r`)
}

function agentInput(command: SandboxNode['command'], from: string, text: string): string {
  const message = `[Alethe message from ${from}] ${text.trim()}`
  return command === 'shell' ? shellLine(message) : `${message}\r`
}

export const useAgentSandboxStore = create<AgentSandboxState>((set, get) => ({
  active: false,
  cwd: null,
  nodes: [],
  messages: [],
  groups: [],
  runningDemo: false,

  startDemo: async (cwd) => {
    get().stop()
    const generation = ++sandboxGeneration
    const [endpoint, token, settingsPath] = await Promise.all([agentHooksEndpoint(), agentHooksToken(), agentHooksSettingsPath()])
    if (generation !== sandboxGeneration) return
    set({
      active: true,
      cwd,
      runningDemo: true,
      messages: [],
      groups: [],
      nodes: DEMO_NODES.map((node) => ({
        ...node,
        ptyId: null,
        status: 'starting',
        lastMessage: null,
        output: '',
        managed: true,
      })),
    })

    // Lord D1: o evento `agent-spawn` foi apagado pelo contrato v1 do `/spawn`
    // (substituído por `lord-agent-spawn-v1`, consumido só por
    // `useAgentSpawnListener`). O listener que existia aqui nunca mais dispara —
    // removido junto com `SpawnPayload`, `spawnEventCleanup` e o fluxo de
    // negociação de app-server do Codex que só ele alimentava. O restante da
    // sandbox (demo `lead`, `agent-hook`, mensageria entre nodes) continua de pé.
    hookEventCleanup = await listen<Record<string, unknown>>('agent-hook', (event) => {
      if (generation !== sandboxGeneration) return
      const payload = event.payload
      const eventCwd = typeof payload.cwd === 'string' ? payload.cwd : ''
      if (!eventCwd) return
      const child = get().nodes.find((node) =>
        node.id !== 'lead' &&
        node.command === 'claude' &&
        Boolean(node.parentId) &&
        Boolean(node.cwd) &&
        normalizeSandboxPath(node.cwd!) === normalizeSandboxPath(eventCwd),
      )
      const parent = child?.parentId ? get().nodes.find((node) => node.id === child.parentId) : undefined
      if (!child || !parent?.ptyId) return
      void writeAgentMessage(parent.ptyId, hookSummary(payload)).catch((error) => {
        console.error('[sandbox] Claude hook relay failed', { child: child.id, error })
      })
    })

    for (const node of DEMO_NODES) {
      const ptyId = `sandbox-${node.id}-${nanoid(6)}`
      try {
        await spawnPty({
          id: ptyId,
          cols: 88,
          rows: 24,
          cwd,
          command: node.command === 'shell' ? undefined : node.command,
          extraArgs: [...(node.extraArgs ?? []), '--settings', settingsPath],
          env: { ALETHE_AGENT_HOOKS_ENDPOINT: endpoint, ALETHE_AGENT_HOOKS_TOKEN: token },
        })
        if (generation !== sandboxGeneration) {
          await killPty(ptyId).catch(() => {})
          return
        }
        const unlisten = await listenPtyExit(ptyId, () => {
          set((state) => ({
            nodes: state.nodes.map((item) =>
              item.ptyId === ptyId ? { ...item, status: 'done' } : item,
            ),
          }))
        })
        exitCleanups.set(ptyId, unlisten)
        set((state) => ({
          nodes: state.nodes.map((item) =>
            item.id === node.id ? { ...item, ptyId, status: 'idle' } : item,
          ),
        }))
      } catch {
        set((state) => ({
          nodes: state.nodes.map((item) =>
            item.id === node.id ? { ...item, status: 'error' } : item,
          ),
        }))
      }
    }

    set({ runningDemo: false })
  },

  stop: () => {
    sandboxGeneration += 1
    hookEventCleanup?.()
    hookEventCleanup = null
    outputCleanups.forEach((cleanup) => cleanup())
    outputCleanups.clear()
    appServerCleanups.forEach((cleanup) => cleanup())
    appServerCleanups.clear()
    exitCleanups.forEach((cleanup) => cleanup())
    exitCleanups.clear()
    get().nodes.forEach((node) => {
      if (node.managed !== false && node.ptyId) void killPty(node.ptyId).catch(() => {})
      if (node.appServerId) void codexAppServerStop(node.appServerId).catch(() => {})
    })
    set({ active: false, cwd: null, nodes: [], groups: [], messages: [], runningDemo: false })
  },

  moveNode: (id, x, y) =>
    set((state) => ({
      nodes: state.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)),
    })),

  resizeNode: (id, width, height) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === id
          ? { ...node, width: Math.max(220, width), height: Math.max(170, height) }
          : node,
      ),
    })),

  clearInitialInput: (id) =>
    set((state) => ({
      nodes: state.nodes.map((node) => node.id === id ? { ...node, initialInput: undefined } : node),
    })),

  sendMessage: async (from, to, text) => {
    const source = get().nodes.find((node) => node.id === from)
    const target = get().nodes.find((node) => node.id === to)
    if ((!target?.ptyId && !target?.appServerId) || (target.appServerId && !target.threadId) || !text.trim()) return
    const message: SandboxMessage = {
      id: nanoid(),
      from,
      to,
      text: text.trim(),
      createdAt: Date.now(),
      state: 'sending',
    }
    set((state) => ({
      messages: [...state.messages, message].slice(-80),
      nodes: state.nodes.map((node) =>
        node.id === to ? { ...node, status: 'working', lastMessage: text.trim() } : node,
      ),
    }))
    try {
      if (target.appServerId && target.threadId) {
          await codexAppServerSend(target.appServerId, {
            id: Date.now(),
            method: 'turn/start',
            params: { threadId: target.threadId, input: [{ type: 'text', text: `[Message from ${source?.label ?? from}] ${text.trim()}` }], approvalPolicy: 'never' },
          })
      } else if (target.ptyId) {
        await writePty(target.ptyId, agentInput(target.command, source?.label ?? from, text))
      }
      set((state) => ({
        messages: state.messages.map((item) =>
          item.id === message.id ? { ...item, state: 'delivered' } : item,
        ),
        nodes: state.nodes.map((node) =>
          node.id === to && !node.appServerId ? { ...node, status: 'idle' } : node,
        ),
      }))
    } catch {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === to ? { ...node, status: 'error' } : node)),
      }))
    }
  },

  syncProjectTerminals: (terminals) => set((state) => {
    const incomingIds = new Set(terminals.map((terminal) => `terminal-${terminal.id}`))
    const existing = new Map(state.nodes.map((node) => [node.id, node]))
    const managedNodes = state.nodes.filter((node) => node.managed !== false)
    const externalNodes = terminals.map((terminal, index) => {
      const id = `terminal-${terminal.id}`
      const current = existing.get(id)
      return {
        id,
        label: terminal.label,
        role: 'project terminal',
        command: terminal.command,
        ptyId: terminal.ptyId,
        cwd: terminal.cwd,
        status: terminal.ptyId ? 'idle' as SandboxNodeStatus : 'starting' as SandboxNodeStatus,
        x: current?.x ?? 90 + index * 32,
        y: current?.y ?? 370,
        width: current?.width ?? 420,
        height: current?.height ?? 300,
        color: current?.color ?? 'var(--accent)',
        lastMessage: current?.lastMessage ?? null,
        managed: false,
      }
    })
    const nextGroups = state.groups.map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => managedNodes.some((node) => node.id === id) || incomingIds.has(id)) })).filter((group) => group.nodeIds.length > 1)
    return { nodes: [...managedNodes, ...externalNodes], groups: nextGroups }
  }),

  groupNodes: (nodeIds) => set((state) => {
    const uniqueIds = [...new Set(nodeIds)].filter((id) => state.nodes.some((node) => node.id === id))
    if (uniqueIds.length < 2) return state
    return { groups: [...state.groups, { id: `group-${nanoid(6)}`, label: `Agent group ${state.groups.length + 1}`, nodeIds: uniqueIds }] }
  }),

  ungroupNodes: (groupId) => set((state) => ({ groups: state.groups.filter((group) => group.id !== groupId) })),
}))
