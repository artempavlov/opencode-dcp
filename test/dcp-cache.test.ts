import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Exercise the shipped implementation, not a second implementation of the fix.
// The upstream bundle keeps these helpers private; loading only its pure prefix
// avoids plugin setup, storage access, and provider requests.
const source = readFileSync(new URL("../dcp/vendor/index.js", import.meta.url), "utf8")
  .split("var index_default = Plugin.define")[0]!
  .replace(/^import .*;\n/gm, "")
const api = new Function(`${source}\nreturn {applyCompressionBlocks,resolvePlans,scanTranscript,createSessionState,RefRegistry}`)()
const message = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const block = (blockId: number, anchorKey: string, coveredKeys: string[]) => ({
  blockId, active: true, anchorKey, coveredKeys, summary: `Summary b${blockId}`,
})
const state = (blocks: ReturnType<typeof block>[]) => ({
  ...api.createSessionState("test"),
  activeBlockIds: blocks.map((item) => item.blockId),
  blocks: Object.fromEntries(blocks.map((item) => [item.blockId, item])),
})
const apply = (current: ReturnType<typeof state>, keys: string[]) => {
  const messages = keys.map(message)
  api.applyCompressionBlocks(current, messages, keys)
  return messages
}

test("DCP tail summary stays before turns appended after compression", () => {
  const current = state([block(1, "tail", ["old"])])
  const before = apply(current, ["old"])
  const after = apply(current, ["old", "new"])
  expect(after).toEqual([message("Summary b1"), message("new")])
  expect(after.slice(0, before.length)).toEqual(before)
})

test("DCP tail summary preserves an untouched prefix and every later turn", () => {
  const current = state([block(1, "tail", ["old1", "old2"])])
  let previous = apply(current, ["prefix", "old1", "old2"])
  for (let i = 1; i <= 20; i++) {
    const next = apply(current, ["prefix", "old1", "old2", ...Array.from({ length: i }, (_, j) => `new${j}`)])
    expect(next.slice(0, previous.length)).toEqual(previous)
    previous = next
  }
})

test("DCP recovers an absent successor anchor from covered history", () => {
  expect(apply(state([block(1, "missing", ["old"])]), ["prefix", "old", "new"]))
    .toEqual([message("prefix"), message("Summary b1"), message("new")])
})

test("DCP leaves valid successor anchors unchanged", () => {
  expect(apply(state([block(1, "next", ["old"])]), ["prefix", "old", "next", "new"]))
    .toEqual([message("prefix"), message("Summary b1"), message("next"), message("new")])
})

test("DCP orders multiple legacy tail blocks chronologically", () => {
  const current = state([block(1, "tail", ["old1"]), block(2, "tail", ["old2"])])
  expect(apply(current, ["old1", "gap", "old2", "new"]))
    .toEqual([message("Summary b1"), message("gap"), message("Summary b2"), message("new")])
})

test("DCP fixes persisted blocks without rewriting their state", () => {
  const current = state([block(1, "tail", ["old"])])
  const saved = JSON.stringify(current)
  const restored = JSON.parse(saved)
  expect(apply(restored, ["old", "new"])).toEqual([message("Summary b1"), message("new")])
  expect(JSON.stringify(restored)).toBe(saved)
})

test("DCP pruning boundaries use the same recovered summary position", () => {
  const messages = [message("old"), message("new")]
  const index = api.scanTranscript(messages)
  const runtime = { state: state([block(1, "tail", [index.keys[0]])]), refs: new api.RefRegistry() }
  runtime.refs.project(index.keys.slice(1))
  const plans = api.resolvePlans({ topic: "test", content: [{ startId: "b1", endId: "m0001", summary: "Combined" }] }, index, runtime)
  expect(plans[0].coveredKeys).toEqual(index.keys)
  expect(plans[0].consumedBlockIds).toEqual([1])
})
