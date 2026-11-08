import assert from "node:assert/strict"
import { test } from "node:test"
import { startEventPump } from "../lib/events"
import { resolveOptions } from "../lib/config"
import { effectiveContextLimit } from "../lib/constants"
import { createLogger } from "../lib/logger"
import { expandPlaceholders } from "../lib/prune-tool"
import { UsageTracker } from "../lib/nudges"
import { StateStore, applyCompression } from "../lib/state/store"
import { createContextHook } from "../lib/transform"
import { TranscriptMirror } from "../lib/transcript/mirror"
import { scanTranscript } from "../lib/transcript/scan"
import type { WireMessage } from "../lib/types"

const sessionId = "ses_revert"
const message = (id: string, text = id): WireMessage => ({ id, role: "user", content: [{ type: "text", text }] })

function harness() {
  const saved = new Map<string, unknown>()
  const store = new StateStore({
    async get(key) { return structuredClone(saved.get(key)) },
    async set(key, value) { saved.set(key, structuredClone(value)) },
    async remove(key) { saved.delete(key) },
  })
  const mirror = new TranscriptMirror()
  const usage = new UsageTracker()
  const logger = createLogger(false)
  const deps = { store, mirror, usage, logger }
  const hook = createContextHook({ ...deps, config: resolveOptions(undefined, () => {}),
    isSubAgent: async () => false, catalogContextLimit: async () => 200000 })
  const dispatch = async (messages: WireMessage[]) => {
    const copy = structuredClone(messages)
    await hook({ sessionID: sessionId, agent: "default", model: { providerID: "p", id: "m" }, system: [], messages: copy })
    return copy
  }
  const block = async (messages: WireMessage[], summary: string, consumedBlockIds: number[] = []) => {
    const runtime = await store.ensure(sessionId)
    return applyCompression({ state: runtime.state, refs: runtime.refs, topic: "revert", summary,
      coveredKeys: scanTranscript(messages).keys, coveredToolIds: [], coveredTokens: 1000,
      consumedBlockIds, anchorKey: "tail" })
  }
  const commit = async (to: string) => {
    const controller = new AbortController()
    await startEventPump({ ...deps, signal: controller.signal, subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "session.revert.committed", data: { sessionID: sessionId, to } }
        controller.abort()
      },
    }) })
  }
  return { ...deps, saved, dispatch, block, commit }
}

test("committed revert preserves a 550K-token prefix summary and its persistent state", async () => {
  const h = harness()
  const old = message("old", "long old history ".repeat(140000))
  const removed = message("removed")
  await h.dispatch([old, removed])
  await h.block([old], "retained summary")
  await h.store.persist(sessionId)
  await h.commit("removed")
  const output = await h.dispatch([old, message("replacement")])
  const text = JSON.stringify(output)
  assert.ok(text.includes("retained summary"))
  assert.ok(!text.includes("long old history"))
  assert.ok(text.length < 10000)
  assert.equal(old.content[0]!.type === "text" && old.content[0]!.text.length > 2000000, true)
  assert.ok(h.saved.has(`session/${sessionId}`))
  const reloaded = new StateStore({ async get(key) { return structuredClone(h.saved.get(key)) }, async set() {}, async remove() {} })
  assert.deepEqual((await reloaded.ensure(sessionId)).state.activeBlockIds, [1])
  assert.equal(h.mirror.get(sessionId)?.keys.includes("id:replacement"), true)
})

test("partial and fully removed summaries cannot leak reverted text; old consumed children return", async () => {
  const h = harness()
  const prefix = message("prefix")
  const removed = message("removed", "secret reverted original")
  const child = await h.block([prefix], "safe old summary")
  await h.block([prefix, removed], "unsafe future summary", [child.blockId])
  await h.block([message("gone")], "entirely removed summary")
  await h.dispatch([prefix, removed, message("gone")])
  await h.commit("removed")
  const output = JSON.stringify(await h.dispatch([prefix, message("new")]))
  assert.ok(output.includes("safe old summary"))
  assert.ok(!output.includes("unsafe future summary"))
  assert.ok(!output.includes("entirely removed summary"))
  assert.deepEqual((await h.store.ensure(sessionId)).state.activeBlockIds, [child.blockId])
  assert.throws(() => expandPlaceholders("(b2)", h.store.peek(sessionId)!.state), /unknown compressed block/)
})

test("missing revert events are reconciled by the context hook, including after restart", async () => {
  const h = harness()
  const prefix = message("prefix")
  await h.block([prefix], "safe prefix")
  await h.block([message("removed")], "unsafe future")
  await h.store.persist(sessionId)
  const other = harness()
  for (const [key, value] of h.saved) other.saved.set(key, value)
  const text = JSON.stringify(await other.dispatch([prefix, message("new")]))
  assert.ok(text.includes("safe prefix"))
  assert.ok(!text.includes("unsafe future"))
  assert.deepEqual((await other.store.ensure(sessionId)).state.activeBlockIds, [1])
})

test("effective input ceilings and the 60% budget survive the source migration", () => {
  assert.equal(effectiveContextLimit({ context: 1000000, input: 200000 }), 200000)
  assert.equal(effectiveContextLimit({ context: 128000, input: 200000 }), 128000)
  assert.equal(effectiveContextLimit({ input: 200000 }), 200000)
  for (const context of [0, -1, Infinity, NaN]) assert.equal(effectiveContextLimit({ context, input: 200000 }), 200000)
  assert.equal(effectiveContextLimit(), undefined)
  assert.equal(resolveOptions(undefined, () => {}).maxContextLimit, "60%")
})
