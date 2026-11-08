import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { once } from "node:events"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Opt-in integration test: real V2 runtime, isolated data, local fake provider.
test("V2 keeps compression across tail revert, replacement, and process restart", { timeout: 90000 }, async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url))
  await mkdir(path.join(repo, ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(repo, ".tmp/runtime-revert-"))
  const calls = []
  const endpoint = createServer(async (request, response) => {
    let text = ""
    for await (const chunk of request) text += chunk
    calls.push(JSON.parse(text))
    const first = calls.length === 1
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "call_prune", type: "function", function: {
      name: "prune", arguments: JSON.stringify({ topic: "fixture", content: [{ startId: "m0001", endId: "m0001", summary: "Safe retained fixture summary." }] }),
    } }] } : { role: "assistant", content: "Fixture complete" }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end([
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n")
  })
  endpoint.listen(0, "127.0.0.1")
  await once(endpoint, "listening")
  await mkdir(path.join(root, "config/opencode"), { recursive: true })
  await mkdir(path.join(root, "no-title"))
  await writeFile(path.join(root, "no-title/index.ts"), `import { Plugin } from "@opencode/plugin"; export default Plugin.define({id:"fixture.no-title",async setup(ctx){await ctx.session.hook("title",event=>{event.result="Revert fixture"})}})`)
  await writeFile(path.join(root, "no-title/package.json"), JSON.stringify({ name: "fixture-no-title", type: "module", main: "./index.ts" }))
  await writeFile(path.join(root, "config/opencode/opencode.jsonc"), JSON.stringify({
    providers: { fixture: { package: "@opencode/ai/providers/openai/chat", settings: { baseURL: `http://127.0.0.1:${endpoint.address().port}/v1`, apiKey: "fixture" }, models: { model: { limit: { context: 400000, input: 200000, output: 8192 } } } } },
    model: "fixture/model",
    plugins: [{ package: process.env.DCP_PLUGIN_SOURCE ?? path.join(repo, "dist"), options: { maxContextLimit: "1%" } }, path.join(root, "no-title")],
    compaction: { auto: false },
    permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "prune", resource: "*", effect: "allow" }],
  }))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_")) delete env[key]
  Object.assign(env, { XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"), TMPDIR: root,
    OPENCODE_PASSWORD: "fixture", OPENCODE_DISABLE_PROJECT_CONFIG: "1" })
  let child
  let stderr = ""
  const start = async () => {
    child = spawn(process.env.OPENCODE_V2_BINARY ?? `${process.env.HOME}/.local/lib/opencode-v2/2.2.5/opencode`, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const url = await new Promise((resolve, reject) => {
      let stdout = ""
      child.stdout.on("data", (chunk) => {
        stdout += chunk
        const match = stdout.match(/server listening on (http:\/\/[^\s]+)/)
        if (match) resolve(match[1])
      })
      child.once("error", reject)
      child.once("exit", () => reject(new Error(`Server exited: ${stderr}`)))
    })
    return async (route, body, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(`${url}/api/${route}`, { method, headers: { Authorization: `Basic ${btoa("opencode:fixture")}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
      const text = await response.text()
      assert.ok(response.ok, `${route}: ${response.status} ${text}`)
      return text ? JSON.parse(text) : undefined
    }
  }
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill()
    await exited
  }
  try {
    let api = await start()
    const location = `location[directory]=${encodeURIComponent(root)}`
    await api(`model?${location}`)
    const plugins = await api(`plugin?${location}`)
    assert.equal(plugins.data.find((item) => item.id === "opencode.dcp")?.state.status, "active")
    const session = (await api("session", { location: { directory: root } })).data
    const route = `session/${session.id}`
    const prompt = async (text) => {
      const result = (await api(`${route}/prompt`, { text, resume: true })).data
      await api(`experimental/${route}/wait`, {})
      return result
    }
    const old = "Fixture old history".repeat(650)
    await prompt(old)
    await prompt("Fixture retained turn")
    await prompt("Fixture removed turn")
    assert.equal(calls.length, 4)
    assert.deepEqual(calls[3].messages.slice(0, calls[2].messages.length), calls[2].messages,
      "appending turns must keep the prior request as an unchanged cache prefix")
    const before = structuredClone(calls.at(-1).messages)
    assert.match(JSON.stringify(calls[0].messages), /200,000-token/)
    assert.match(JSON.stringify(calls[0].messages), /prune now/)
    const history = (await api(`${route}/context`)).data
    const removed = history.find((item) => item.type === "user" && item.text === "Fixture removed turn")
    assert.ok(removed)
    // Stage/clear is non-destructive; then reproduce the committed-tail path.
    await api(`${route}/revert/stage`, { messageID: removed.id, files: false })
    await api(`${route}/revert`, undefined, "DELETE")
    await api(`${route}/revert/stage`, { messageID: removed.id, files: false })
    await api(`${route}/revert/commit`, {})
    await prompt("Fixture replacement turn")
    const after = calls.at(-1).messages
    const summaryPosition = (messages) => messages.findIndex((message) => message.role === "user" && JSON.stringify(message.content).includes("[Compressed conversation section]"))
    assert.ok(!JSON.stringify(after).includes("Fixture old history"), "revert must not resurrect compressed originals")
    assert.ok(summaryPosition(after) >= 0)
    assert.equal(summaryPosition(after), summaryPosition(before))
    assert.ok(!JSON.stringify(after).includes("Fixture removed turn"))
    const stored = (await api(`${route}/context`)).data
    assert.ok(stored.some((item) => item.type === "user" && item.text === old), "stored raw history must not change")
    await stop()
    api = await start()
    await prompt("Fixture after restart")
    assert.ok(!JSON.stringify(calls.at(-1).messages).includes("Fixture old history"))
    assert.ok(summaryPosition(calls.at(-1).messages) >= 0)
    console.log(JSON.stringify({ root, providerRequests: calls.length, summaryPosition: summaryPosition(after), rawHistoryPreserved: true, restartPassed: true }))
  } catch (error) {
    console.error(stderr.slice(-4000))
    try { console.error((await readFile(path.join(root, "data/opencode/log/opencode.log"), "utf8")).split("\n").filter((line) => /failed|error/i.test(line)).slice(-12).join("\n")) } catch {}
    throw error
  } finally {
    await stop()
    await new Promise((resolve) => endpoint.close(resolve))
  }
})
