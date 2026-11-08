import { formatBlockRef, RefRegistry } from "../refs"
import { countTokens } from "../tokens"
import { createSessionState, hydrateSessionState, type CompressionBlock, type SessionState } from "./types"

/** In-memory per-session bundle: persisted state plus its live ref registry. */
export interface SessionRuntime {
  sessionId: string
  state: SessionState
  refs: RefRegistry
}

export type JsonStorage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * Per-session state store with an in-memory cache and JSON persistence through
 * the plugin storage KV (namespaced per plugin by the host).
 */
export class StateStore {
  private readonly memory = new Map<string, SessionRuntime>()
  private readonly pending = new Map<string, Promise<SessionRuntime>>()

  constructor(private readonly storage: JsonStorage | undefined) {}

  /** Cached runtime without loading from storage (may be undefined). */
  peek(sessionId: string): SessionRuntime | undefined {
    return this.memory.get(sessionId)
  }

  async ensure(sessionId: string): Promise<SessionRuntime> {
    const cached = this.memory.get(sessionId)
    if (cached) return cached
    const inflight = this.pending.get(sessionId)
    if (inflight) return inflight
    const load = (async () => {
      let state = createSessionState(sessionId)
      if (this.storage) {
        try {
          const stored = await this.storage.get(`session/${sessionId}`)
          state = hydrateSessionState(stored, sessionId)
        } catch {
          // Corrupt or missing entry: start fresh.
        }
      }
      const runtime: SessionRuntime = {
        sessionId,
        state,
        refs: RefRegistry.from(state.refs),
      }
      this.memory.set(sessionId, runtime)
      return runtime
    })()
    this.pending.set(sessionId, load)
    try {
      return await load
    } finally {
      this.pending.delete(sessionId)
    }
  }

  async persist(sessionId: string): Promise<void> {
    const runtime = this.memory.get(sessionId)
    if (!runtime || !this.storage) return
    runtime.state.refs = runtime.refs.toJSON()
    runtime.state.updatedAt = Date.now()
    try {
      await this.storage.set(`session/${sessionId}`, runtime.state as unknown as Record<string, unknown>)
    } catch {
      // Persistence is best-effort; in-memory state keeps working.
    }
  }

  /** Keep only whole summaries whose original messages still exist. */
  async reconcile(sessionId: string, keys: readonly string[]): Promise<void> {
    const runtime = await this.ensure(sessionId)
    const present = new Set(keys)
    const retained: number[] = []
    const seen = new Set<number>()
    const visit = (id: number): void => {
      if (seen.has(id)) return
      seen.add(id)
      const block = runtime.state.blocks[String(id)]
      if (!block) return
      if (block.coveredKeys.length > 0 && block.coveredKeys.every((key) => present.has(key))) {
        retained.push(id)
      } else {
        // A later fold can straddle the cutoff while its older children remain
        // valid. Never keep a partial summary: it can reveal reverted content.
        for (const child of block.consumedBlockIds) visit(child)
      }
    }
    for (const id of runtime.state.activeBlockIds) visit(id)
    // Invalid inactive blocks must go too: `(bN)` expansion can otherwise
    // resurrect their reverted text during a later prune.
    let removed = false
    for (const [id, block] of Object.entries(runtime.state.blocks)) {
      if (block.coveredKeys.length === 0 || !block.coveredKeys.every((key) => present.has(key))) {
        delete runtime.state.blocks[id]
        removed = true
      }
    }
    if (!removed && retained.length === runtime.state.activeBlockIds.length &&
        retained.every((id, i) => id === runtime.state.activeBlockIds[i])) return
    const active = new Set(retained)
    for (const block of Object.values(runtime.state.blocks)) block.active = active.has(block.blockId)
    runtime.state.activeBlockIds = retained
    runtime.state.nudgeAnchors = []
    runtime.state.pruneAckSeq = runtime.state.pruneSeq
    await this.persist(sessionId)
  }

  /** Drops all DCP edits for a session (native compaction / deletion). */
  reset(sessionId: string): void {
    this.memory.delete(sessionId)
    void this.storage?.remove(`session/${sessionId}`)?.catch(() => {})
  }
}

/** Sentinel anchor key meaning "append at transcript tail". */
export const TAIL_ANCHOR = "tail"

/** Recover the fixed compression-time boundary, including legacy tail anchors. */
export function compressionAnchorIndex(block: CompressionBlock, positions: ReadonlyMap<string, number>, length: number): number {
  const successor = block.anchorKey === TAIL_ANCHOR ? undefined : positions.get(block.anchorKey)
  if (successor !== undefined) return successor
  let last = -1
  for (const key of block.coveredKeys) last = Math.max(last, positions.get(key) ?? -1)
  return last < 0 ? length : last + 1
}

export function allocateBlockId(state: SessionState): number {
  const blockId = state.nextBlockId++
  return blockId
}

export function wrapCompressedSummary(blockId: number, summary: string): string {
  const ref = formatBlockRef(blockId)
  return `[Compressed conversation section]\n${summary.trim()}\n<dcp-message-id>${ref}</dcp-message-id>`
}

/**
 * Applies a validated compression to session state: records the new block,
 * deactivates consumed blocks, and accounts tokens.
 */
export function applyCompression(input: {
  state: SessionState
  refs: RefRegistry
  topic: string
  summary: string
  coveredKeys: string[]
  coveredToolIds: string[]
  coveredTokens: number
  consumedBlockIds: number[]
  anchorKey: string
}): CompressionBlock {
  const { state } = input
  const blockId = allocateBlockId(state)
  const wrapped = wrapCompressedSummary(blockId, input.summary)
  const block: CompressionBlock = {
    blockId,
    active: true,
    topic: input.topic,
    summary: wrapped,
    summaryTokens: countTokens(wrapped),
    compressedTokens: Math.max(0, input.coveredTokens),
    coveredKeys: [...input.coveredKeys],
    coveredToolIds: [...input.coveredToolIds],
    anchorKey: input.anchorKey,
    consumedBlockIds: [...input.consumedBlockIds],
    createdAt: Date.now(),
  }
  state.blocks[String(blockId)] = block

  const replacementIndex = state.activeBlockIds.findIndex((id) => input.consumedBlockIds.includes(id))
  for (const consumedId of input.consumedBlockIds) {
    const consumed = state.blocks[String(consumedId)]
    if (consumed && consumed.active) {
      consumed.active = false
      state.activeBlockIds = state.activeBlockIds.filter((id) => id !== consumedId)
    }
    // Covered keys of consumed blocks stay covered through the new block.
  }

  // Drop the boundary-ID alias of every newly-covered key: the new block's own
  // coverage plus everything the consumed blocks covered (their coverage just
  // folded into this block). Persisted block.coveredKeys arrays stay intact.
  //
  // Since refs became a per-dispatch projection (`RefRegistry.project`, called
  // by the context hook), the next dispatch would rebuild the table from the
  // visible keys anyway - this is not capacity reclaim. It is the guard for
  // the window BETWEEN a prune and that rebuild: a model may emit several
  // tool calls in one assistant message, so a second `prune` in the same
  // dispatch can run against aliases the first one just covered. Without the
  // drop, `byRef` would still resolve a covered key and the second call would
  // re-cover it instead of failing loudly. Refs are recomputed wholesale each
  // dispatch, so renumbering these keys is safe.
  const releasedKeys = [
    ...input.coveredKeys,
    ...input.consumedBlockIds.flatMap((id) => {
      const consumed = state.blocks[String(id)]
      return consumed ? consumed.coveredKeys : []
    }),
  ]
  input.refs.release(releasedKeys)

  // Keys already covered by consumed blocks are re-covered by this block only;
  // keys must not be double-counted in active coverage.
  for (const id of state.activeBlockIds) {
    const other = state.blocks[String(id)]
    if (!other) continue
    other.coveredKeys = other.coveredKeys.filter((key) => !input.coveredKeys.includes(key))
  }

  // Replacements keep their slot so summaries sharing an anchor do not reorder.
  state.activeBlockIds.splice(replacementIndex < 0 ? state.activeBlockIds.length : replacementIndex, 0, blockId)
  state.stats.compressRuns += 1
  state.nudgeAnchors = []
  // The next dispatch owes the model one acknowledgement: the pressure
  // reminder it just acted on describes the pre-prune context.
  state.pruneSeq += 1
  return block
}

/** Active blocks in summary insertion order. */
export function activeBlocks(state: SessionState): CompressionBlock[] {
  return state.activeBlockIds
    .map((id) => state.blocks[String(id)])
    .filter((block): block is CompressionBlock => block !== undefined && block.active)
}
