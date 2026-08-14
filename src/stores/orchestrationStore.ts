import { create } from 'zustand'

import {
  EMPTY_ORCHESTRATION_PROJECTION,
  reduceOrchestrationProjection,
  type OrchestrationEvent,
  type OrchestrationProjection,
} from '../lib/orchestration'

const AUTO_FOCUS_BURST_MS = 1_500

type OrchestrationState = OrchestrationProjection & {
  autoFocusAtByScope: Record<string, number>
  recordEvent: (event: OrchestrationEvent) => void
  claimAutoFocus: (scopeId: string, occurredAt?: number) => boolean
  reset: () => void
}

// Lord F3: Store propositalmente efêmero; não usa persist e nunca entra em projects.json.
export const useOrchestrationStore = create<OrchestrationState>((set) => ({
  ...EMPTY_ORCHESTRATION_PROJECTION,
  autoFocusAtByScope: {},
  recordEvent: (event) => set((state) => reduceOrchestrationProjection(state, event)),
  claimAutoFocus: (scopeId, occurredAt = Date.now()) => {
    let claimed = false
    set((state) => {
      const previous = state.autoFocusAtByScope[scopeId]
      if (previous !== undefined && occurredAt - previous < AUTO_FOCUS_BURST_MS) return state
      claimed = true
      return {
        autoFocusAtByScope: { ...state.autoFocusAtByScope, [scopeId]: occurredAt },
      }
    })
    return claimed
  },
  reset: () => set({ ...EMPTY_ORCHESTRATION_PROJECTION, autoFocusAtByScope: {} }),
}))
