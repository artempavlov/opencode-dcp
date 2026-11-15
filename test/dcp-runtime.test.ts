import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { cp, mkdir, mkdtemp } from "node:fs/promises"
import path from "node:path"

test("official V2 dispatches a fixed DCP summary before appended turns", async () => {
  const oldText = "Fixture old history".repeat(650)
  await mkdir(path.resolve(import.meta.dir, "../.tmp"), { recursive: true })
  const root = await mkdtemp(path.resolve(import.meta.dir, "../.tmp/dcp-cache-test-"))
  const calls: { messages: { role: string; content?: unknown; tool_calls?: unknown }[] }[] = []
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as typeof calls[number]
    calls.push(body)
    const delta = calls.length === 1
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call_prune", type: "function", function: {
          name: "prune", arguments: JSON.stringify({ topic: "fixture", content: [{ startId: "m0001", endId: "m0001", summary: "Fixture summary, stable in chronological order." }] }),
        } }] }
      : { role: "assistant", content: "Fixture complete" }
    return new Response([
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: calls.length === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  await mkdir(path.join(root, "config/opencode"), { recursive: true })
  await cp(process.env.DCP_PLUGIN_SOURCE ?? path.resolve(import.meta.dir, "../dcp"), path.join(root,"config/opencode/dcp"), {recursive:true})
  await mkdir(path.join(root, "config/opencode/no-title"))
  await Bun.write(path.join(root, "config/opencode/no-title/package.json"), JSON.stringify({name:"dcp-cache-fixture",type:"module",main:"./index.ts"}))
  await Bun.write(path.join(root, "config/opencode/no-title/index.ts"), `import { Plugin } from "@opencode/plugin"; export default Plugin.define({id:"fixture.no-title", async setup(ctx) {await ctx.session.hook("title", event=>{event.result="Cache fixture"})}})`)
  await Bun.write(path.join(root, "config/opencode/opencode.jsonc"), JSON.stringify({
    providers: { fixture: { package: "@opencode/ai/providers/openai/chat", settings: { baseURL: `${endpoint.url}v1`, apiKey: "fixture" }, models: { model: { limit: { context: 400000, input: 200000, output: 8192 } } } } },
    model: "fixture/model",
    plugins: [{ package: "./dcp", options: { maxContextLimit: "1%" } }, "./no-title"],
    compaction: { auto: false },
    permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "prune", resource: "*", effect: "allow" }],
  }))
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"), TMPDIR: root, OPENCODE_PASSWORD: "fixture", OPENCODE_DISABLE_PROJECT_CONFIG: "1" }
  for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_DB", "OPENCODE_SERVER", "OPENCODE_PURE"]) delete env[key as keyof typeof env]
  const child = Bun.spawn([process.env.OPENCODE_V2_BINARY ?? `${process.env.HOME}/.local/lib/opencode-v2/2.2.5/opencode`, "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: root, env, stdout: "pipe", stderr: "pipe" })
  let stderr = ""
  const errors = (async () => { for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk) })()
  try {
    const reader = child.stdout.getReader()
    let stdout = ""
    const url = await (async () => {
      while (true) {
        const read = await reader.read()
        if (read.done) throw new Error(`Server exited: ${stderr}`)
        stdout += new TextDecoder().decode(read.value)
        const match = stdout.match(/server listening on (http:\/\/[^\s]+)/)
        if (match) return match[1]!
      }
    })()
    const client = OpenCode.make({ baseUrl: url, headers: { Authorization: `Basic ${btoa("opencode:fixture")}` } })
    await client.model.list({ location: { directory: root } })
    const plugins = (await client.plugin.list({ location: { directory: root } })).data
    expect(plugins.find((item) => item.id === "opencode.dcp")?.state.status).toBe("active")
    expect(plugins.find((item) => item.id === "fixture.no-title")?.state.status).toBe("active")
    const session = await client.session.create({ location: { directory: root } })
    for (const text of [oldText, "Fixture new turn", "Fixture newest turn"]) {
      await client.session.prompt({ sessionID: session.id, text, resume: true })
      await client.experimental.session.wait({ sessionID: session.id })
    }
    expect(calls).toHaveLength(4)
    // ~3k tokens crosses 1% of input (2k), not 1% of context (4k).
    expect(JSON.stringify(calls[0]!.messages)).toContain("prune now")
    expect(JSON.stringify(calls[0]!.messages)).toContain("200,000-token")
    const summary = (call: typeof calls[number]) => call.messages.findIndex((m) => m.role === "user" && JSON.stringify(m.content).includes("[Compressed conversation section]"))
    expect(summary(calls[1]!)).toBeGreaterThanOrEqual(0)
    expect(summary(calls[2]!)).toBe(summary(calls[1]!))
    expect(summary(calls[3]!)).toBe(summary(calls[1]!))
    expect(JSON.stringify(calls[1]!.messages)).not.toContain("Fixture old history")
    // After the one-time prune acknowledgement, the whole prior request is a prefix.
    expect(calls[3]!.messages.slice(0, calls[2]!.messages.length)).toEqual(calls[2]!.messages)
    const history = await client.session.context({ sessionID: session.id })
    expect(history.some((m) => m.type === "user" && m.text === oldText)).toBe(true)
  } catch (error) {
    console.error(stderr.slice(-6000))
    const log = Bun.file(path.join(root, "data/opencode/log/opencode.log"))
    if (await log.exists()) console.error((await log.text()).split("\n").filter((line) => /session|failed|error/i.test(line)).slice(-30).join("\n"))
    throw error
  } finally {
    child.kill()
    await child.exited
    await errors
    endpoint.stop(true)
    // Keep the private isolated trace under ignored .tmp for diagnosis.
  }
}, 60000)
