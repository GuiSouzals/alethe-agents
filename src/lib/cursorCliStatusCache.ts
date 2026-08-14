import { getCursorCliStatus } from './tauri'
import { makeTtlCache } from './ttlCache'

// Lord F1:
const TTL_MS = 60_000

export const getCachedCursorCliStatus = makeTtlCache(getCursorCliStatus, TTL_MS)
