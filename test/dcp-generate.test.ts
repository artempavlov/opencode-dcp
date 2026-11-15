import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../dcp/vendor/index.js", import.meta.url), "utf8")
  .split("var index_default = Plugin.define")[0]!.replace(/^import .*;\n/gm, "")
const api = new Function(`${source}\nreturn {createGenerateHook,StateStore,createSessionState,RefRegistry,scanTranscript,resolveOptions}`)()

function fixture() {
  const messages = [
    { id: "old", role: "user", content: [{ type: "text", text: "RAW_HISTORY ".repeat(5000) }] },
    { id: "current", role: "user", content: [{ type: "text", text: "Current task" }] },
    { role: "user", content: [{ type: "text", text: "Judge the goal" }] },
  ]
  const keys = api.scanTranscript(messages).keys
  const state = api.createSessionState("generate")
  state.blocks = { "1": { blockId: 1, active: true, topic: "History", coveredKeys: [keys[0]],
    consumedBlockIds: [], coveredToolIds: [], anchorKey: keys[1], summary: "Saved history", summaryTokens: 3 } }
  state.activeBlockIds = [1]
  const refs = new api.RefRegistry(); refs.project(keys)
  const store = new api.StateStore()
  store.memory.set("generate", { sessionId: "generate", state, refs })
  const warnings: unknown[] = []
  const hook = api.createGenerateHook({ store, config: api.resolveOptions({}, () => {}),
    isSubAgent: async () => false, logger: { warn: (...args: unknown[]) => warnings.push(args) } })
  const event = { sessionID: "generate", agent: "build", messages, system: [{ type: "text", text: "System" }],
    model: { providerID: "fixture", id: "model" }, tools: { prune: { description: "Unchanged" } }, options: {} }
  return { state, refs, store, event, hook, warnings, keys }
}

test("generate applies saved blocks without changing primary state, refs or source messages", async () => {
  const f = fixture()
  const before = JSON.stringify({ state: f.state, refs: f.refs.toJSON() })
  const sourceMessages = [...f.event.messages]
  const original = JSON.stringify(sourceMessages)
  const other = JSON.stringify({ system: f.event.system, tools: f.event.tools, options: f.event.options })
  await f.hook(f.event)
  expect(JSON.stringify(f.event.messages).includes("RAW_HISTORY")).toBe(false)
  expect(f.event.messages.map((m: any) => m.content[0].text)).toEqual(["Saved history", "Current task", "Judge the goal"])
  expect(JSON.stringify({ state: f.state, refs: f.refs.toJSON() })).toBe(before)
  expect(JSON.stringify(sourceMessages)).toBe(original)
  expect(JSON.stringify({ system: f.event.system, tools: f.event.tools, options: f.event.options })).toBe(other)
  expect(JSON.stringify(f.event)).not.toContain("dcp-system-reminder")
  expect(f.warnings).toEqual([])
})

test("cold generate reads persisted state without populating runtime or writing storage", async () => {
  const f = fixture(); let reads = 0
  const persisted = structuredClone(f.state)
  const before = JSON.stringify(persisted)
  f.store.memory.clear()
  f.store.storage = { get: async () => { reads++; return persisted },
    set: async () => { throw new Error("Must not persist") }, remove: async () => { throw new Error("Must not reset") } }
  await f.hook(f.event)
  expect(reads).toBe(1)
  expect(f.store.memory.size).toBe(0)
  expect(f.store.pending.size).toBe(0)
  expect(JSON.stringify(persisted)).toBe(before)
  expect(JSON.stringify(f.event.messages).includes("RAW_HISTORY")).toBe(false)
})

test("a partially present parent cannot hide uncovered history; whole child summaries can be reused", async () => {
  const f = fixture()
  f.state.blocks["2"] = { ...f.state.blocks["1"], blockId: 2, coveredKeys: [...f.state.blocks["1"].coveredKeys, "absent"], consumedBlockIds: [1], summary: "Unsafe parent" }
  f.state.blocks["1"].active = false
  f.state.activeBlockIds = [2]
  const before = JSON.stringify(f.state)
  await f.hook(f.event)
  expect(JSON.stringify(f.event.messages)).toContain("Saved history")
  expect(JSON.stringify(f.event.messages)).not.toContain("Unsafe parent")
  expect(JSON.stringify(f.state)).toBe(before)
})

test("missing keys without a whole child leave the original range visible", async () => {
  const f = fixture(); f.state.blocks["1"].coveredKeys.push("absent")
  const before = JSON.stringify(f.event.messages)
  await f.hook(f.event)
  expect(JSON.stringify(f.event.messages)).toBe(before)
})

test("internal agents and excluded subagents do not acquire a primary transform", async () => {
  for (const agent of ["title", "compaction", "summary"]) {
    const f = fixture(); f.event.agent = agent
    const before = JSON.stringify(f.event)
    await f.hook(f.event)
    expect(JSON.stringify(f.event)).toBe(before)
  }
  const f = fixture(); const before = JSON.stringify(f.event)
  const hook = api.createGenerateHook({ store: f.store, config: api.resolveOptions({}, () => {}),
    isSubAgent: async () => true, logger: { warn: () => {} } })
  await hook(f.event)
  expect(JSON.stringify(f.event)).toBe(before)
})

test("missing state and snapshot failures leave the outgoing request untouched", async () => {
  for (const snapshot of [async () => undefined, async () => { throw new Error("Unavailable") }]) {
    const f = fixture(); const before = JSON.stringify(f.event)
    const hook = api.createGenerateHook({ store: { snapshot }, config: api.resolveOptions({}, () => {}),
      isSubAgent: async () => false, logger: { warn: () => {} } })
    await hook(f.event)
    expect(JSON.stringify(f.event)).toBe(before)
  }
})

test("saved tool-output removals are reused without mutating shared message objects", async () => {
  const f = fixture()
  f.state.prunedTools = { result: 1 }
  f.event.messages.push(
    { role: "assistant", content: [{ type: "tool-call", id: "result", name: "read", input: {} }] } as any,
    { role: "tool", content: [{ type: "tool-result", id: "result", name: "read", result: { type: "text", value: "OBSOLETE_OUTPUT" } }] } as any,
  )
  const sourceMessages = [...f.event.messages]
  const before = JSON.stringify(sourceMessages)
  const state = JSON.stringify(f.state)
  await f.hook(f.event)
  expect(JSON.stringify(f.event.messages)).not.toContain("OBSOLETE_OUTPUT")
  expect(JSON.stringify(sourceMessages)).toBe(before)
  expect(JSON.stringify(f.state)).toBe(state)
})

test("each auxiliary snapshot is detached from concurrent primary state changes", async () => {
  const f = fixture()
  const snapshot = await f.store.snapshot("generate")
  f.state.blocks["1"].summary = "New primary summary"
  expect(snapshot.blocks["1"].summary).toBe("Saved history")
  snapshot.activeBlockIds.length = 0
  expect(f.state.activeBlockIds).toEqual([1])
})

test("allowSubAgents explicitly enables the same read-only projection in child sessions", async () => {
  const f = fixture(); const before = JSON.stringify(f.state)
  const hook = api.createGenerateHook({ store: f.store, config: api.resolveOptions({ allowSubAgents: true }, () => {}),
    isSubAgent: async () => true, logger: { warn: () => {} } })
  await hook(f.event)
  expect(JSON.stringify(f.event.messages).includes("RAW_HISTORY")).toBe(false)
  expect(JSON.stringify(f.state)).toBe(before)
})

test("failure after block projection cannot partially replace the outgoing history", async () => {
  const f = fixture()
  f.state.prunedTools = { broken: 1 }
  f.event.messages.push({ role: "tool", content: [{ type: "tool-result", id: "broken", name: "read" }] } as any)
  const before = JSON.stringify(f.event.messages)
  await f.hook(f.event)
  expect(JSON.stringify(f.event.messages)).toBe(before)
  expect(f.warnings).toHaveLength(1)
})
