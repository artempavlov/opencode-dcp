import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Load the shipped pure helpers, as in the cache regression tests.
const source = readFileSync(new URL("../dcp/vendor/index.js", import.meta.url), "utf8")
  .split("var index_default = Plugin.define")[0]!
  .replace(/^import .*;\n/gm, "")
const api = new Function(`${source}\nreturn {effectiveContextLimit,resolveOptions,resolveLimit,maybeContextNudge,createSessionState}`)()

test("DCP uses the smaller positive finite context/input limit", () => {
  expect(api.effectiveContextLimit({ context: 1000000, input: 200000 })).toBe(200000)
  expect(api.effectiveContextLimit({ context: 128000, input: 200000 })).toBe(128000)
  expect(api.effectiveContextLimit({ context: 200000 })).toBe(200000)
  expect(api.effectiveContextLimit({ input: 200000 })).toBe(200000)
  for (const value of [0, -1, Infinity, NaN, "200000", undefined]) {
    expect(api.effectiveContextLimit({ context: value, input: 200000 })).toBe(200000)
    expect(api.effectiveContextLimit({ context: 200000, input: value })).toBe(200000)
  }
  expect(api.effectiveContextLimit({})).toBeUndefined()
  expect(api.effectiveContextLimit(undefined)).toBeUndefined()
})

test("DCP defaults to nudging at 60% of the effective input ceiling", () => {
  const config = api.resolveOptions(undefined, () => {})
  const modelContextLimit = api.effectiveContextLimit({ context: 1000000, input: 200000 })
  expect(config.maxContextLimit).toBe("60%")
  expect(api.resolveLimit(config.maxContextLimit, modelContextLimit)).toBe(120000)
  const input = { config, modelContextLimit, messageCount: 10, state: api.createSessionState("limits") }
  expect(api.maybeContextNudge({ ...input, usageTokens: 119999 })).toBeUndefined()
  expect(api.maybeContextNudge({ ...input, usageTokens: 120000 })).toContain("prune now")
})
