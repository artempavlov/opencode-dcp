import { OpenCode } from "@opencode/client"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { appendFile, cp, mkdir, mkdtemp } from "node:fs/promises"
import path from "node:path"

test.each([[false, false], [true, false], [false, true]])("native goal preserves DCP and overflow fallback (overflow: %s, reload: %s)", async (forceOverflow, reload) => {
  const project = path.resolve(import.meta.dir, "..")
  await mkdir(path.join(project, ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(project, ".tmp/dcp-goal-"))
  const cfg = path.join(root, "config/opencode")
  await mkdir(cfg, { recursive: true })
  await cp(process.env.DCP_PLUGIN_SOURCE ?? path.join(project, "dcp"), path.join(cfg, "dcp"), { recursive: true })
  await mkdir(path.join(cfg, "probe"))
  await Bun.write(path.join(cfg, "probe/package.json"), JSON.stringify({ name: "fixture-probe", type: "module", main: "index.ts" }))
  await Bun.write(path.join(cfg, "probe/index.ts"), `import {Plugin} from "@opencode/plugin";
export default Plugin.define({id:"fixture.probe",async setup(ctx){
 await ctx.session.hook("title",e=>{e.result="Goal fixture"});
}})`)
  const marker = "UNCOMPRESSED_FIXTURE_HISTORY"
  const calls: any[] = []
  let primary = 0, reviews = 0, overflows = 0
  let reviewReached!: () => void, releaseReview!: () => void
  const reviewingNow = new Promise<void>(resolve => { reviewReached = resolve })
  const continueReview = new Promise<void>(resolve => { releaseReview = resolve })
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body: any = await request.json(); calls.push(body)
    const reviewing = JSON.stringify(body.messages.at(-1)).includes("verdict")
    if (!body.stream || reviewing) {
      if (reviewing) {
        reviews++
        if (reload && reviews === 1) { reviewReached(); await continueReview }
        if (forceOverflow || JSON.stringify(body.messages).includes(marker)) {
          overflows++
          return Response.json({ error: { message: "maximum context length exceeded", type: "invalid_request_error", code: "context_length_exceeded" } }, { status: 400 })
        }
      }
      const content = reviewing ? JSON.stringify({ verdict: "done", reason: "Fixture complete" }) : "Checkpoint summary"
      if (body.stream) return new Response(`data: ${JSON.stringify({ id: "review", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "review", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
      return Response.json({ id: "aux", object: "chat.completion", choices: [{ index: 0,
        message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    }
    primary++
    const args = { topic: "Saved fixture history", content: [{ startId: "m0001", endId: "m0001", summary: "Saved fixture history." }] }
    const delta = primary === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-prune", type: "function", function: { name: "prune", arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: "DONE" }
    const chunks = [{ id: "main", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "main", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: primary === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  await Bun.write(path.join(cfg, "opencode.jsonc"), JSON.stringify({
    providers: { fixture: { package: "@opencode/ai/providers/openai/chat", settings: { baseURL: `${endpoint.url}v1`, apiKey: "fixture" }, models: { model: { limit: { context: 168000, input: 168000, output: 8192 } } } } },
    model: "fixture/model", plugins: ["./dcp", "./probe"], compaction: { auto: false },
    permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "prune", resource: "*", effect: "allow" }],
  }))
  const env: any = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"), TMPDIR: root, OPENCODE_PASSWORD: "fixture", OPENCODE_DISABLE_PROJECT_CONFIG: "1" }
  for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_DB", "OPENCODE_SERVER", "OPENCODE_PURE"]) delete env[key]
  const child = Bun.spawn([`${process.env.HOME}/.local/lib/opencode-v2/2.2.5/opencode`, "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: root, env, stdout: "pipe", stderr: "pipe" })
  let stderr = ""
  const errors = (async () => { for await (const c of child.stderr) stderr += new TextDecoder().decode(c) })()
  try {
    const reader = child.stdout.getReader(); let out = "", url = ""
    while (!url) { const r = await reader.read(); if (r.done) throw Error(stderr); out += new TextDecoder().decode(r.value); url = out.match(/server listening on (http:\/\/[^\s]+)/)?.[1] ?? "" }
    const headers = { Authorization: `Basic ${btoa("opencode:fixture")}` }
    const client = OpenCode.make({ baseUrl: url, headers })
    await client.model.list({ location: { directory: root } })
    const session = await client.session.create({ location: { directory: root } })
    await client.session.prompt({ sessionID: session.id, text: `${marker} `.repeat(2500), resume: false })
    await client.session.command({ sessionID: session.id, name: "goal", text: "Finish the fixture objective" })
    if (reload) {
      await Promise.race([reviewingNow, Bun.sleep(10000).then(() => { throw Error("Reviewer did not reach the fixture") })])
      await appendFile(path.join(cfg, "dcp/vendor/index.js"), "\n// Private reload fixture\n")
      const replacing = fetch(`${url}/api/location/reload`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ directory: root }) })
      await Bun.sleep(500)
      releaseReview()
      expect((await replacing).ok).toBe(true)
      expect(child.exitCode).toBe(null)
    }
    const db = new Database(path.join(root, "data/opencode/opencode.db"), { readonly: true })
    db.exec("PRAGMA query_only=ON")
    const key = "plugin:" + [..."opencode.goal"].map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("") + ":session:" + session.id
    let status = "active"
    const deadline = Date.now() + 20000
    try {
      while (status === "active" && Date.now() < deadline) {
        const row: any = db.query("SELECT value FROM kv WHERE key = ?").get(key)
        status = row ? JSON.parse(row.value).status : "active"
        if (status === "active") await Bun.sleep(25)
      }
    } finally { db.close() }
    const history: any = await (await fetch(`${url}/api/session/${session.id}/message`, { headers })).json()
    await Bun.write(path.join(root, "requests.json"), JSON.stringify(calls, null, 2))
    const compactions = history.data.filter((m: any) => m.type === "compaction")
    if (process.env.DEBUG_DCP_TESTS) console.log(JSON.stringify({ root, primary, reviews, overflows, compactions: compactions.map((m: any) => ({ reason: m.reason, status: m.status })) }))
    expect(reviews).toBeGreaterThan(0)
    expect(history.data.some((m: any) => m.content?.some((p: any) => p.name === "prune" && p.state.status === "completed"))).toBe(true)
    const review = calls.find(c => JSON.stringify(c.messages.at(-1)).includes("verdict"))
    expect(JSON.stringify(review.messages).includes(marker)).toBe(false)
    expect(JSON.stringify(review.messages)).toContain("Saved fixture history.")
    expect(JSON.stringify(review.messages).length).toBeLessThan(JSON.stringify(calls[0].messages).length / 2)
    if (forceOverflow) {
      // The provider rejects even the compressed request: Core must still admit
      // its native fallback. This fixture does not test checkpoint quality.
      expect(overflows).toBeGreaterThan(0)
      expect(compactions.some((m: any) => m.reason === "manual")).toBe(true)
      expect(status).toBe("paused")
    } else {
      expect(status).toBe("complete")
      expect(overflows).toBe(0)
      expect(compactions).toHaveLength(0)
      expect(primary).toBe(2)
    }
  } finally { releaseReview(); child.kill(); await child.exited; await errors; endpoint.stop(true) }
}, 60000)
