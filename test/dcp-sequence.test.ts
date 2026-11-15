// Isolated real-runtime sequence. No production session or remote model calls.
import { OpenCode } from "@opencode/client"
import { test } from "bun:test"
import { cp, mkdir, mkdtemp } from "node:fs/promises"
import path from "node:path"
test("official V2 refreshes consecutive prune IDs and gives actionable stale-ID recovery", async () => {
await mkdir(path.resolve(import.meta.dir,"../.tmp"),{recursive:true})
const root = await mkdtemp(path.resolve(import.meta.dir, "../.tmp/dcp-sequence-"))
const cfg = path.join(root, "config/opencode")
await mkdir(cfg, { recursive: true })
await cp(process.env.DCP_PLUGIN_SOURCE ?? path.resolve(import.meta.dir,"../dcp"), path.join(cfg, "dcp"), {recursive:true})
await mkdir(path.join(cfg, "no-title"))
await Bun.write(path.join(cfg,"no-title/package.json"), JSON.stringify({name:"fixture-no-title",type:"module",main:"index.ts"}))
await Bun.write(path.join(cfg,"no-title/index.ts"), `import {Plugin} from "@opencode/plugin"; export default Plugin.define({id:"fixture.no-title",async setup(ctx){await ctx.session.hook("title",e=>{e.result="DCP sequence"})}})`)
const calls:any[]=[]
let persistReached!:()=>void,releasePersist!:()=>void
const persisting=new Promise<void>(resolve=>{persistReached=resolve})
const continuePersist=new Promise<void>(resolve=>{releasePersist=resolve})
let reached!:()=>void
const pendingRequest=new Promise<void>(resolve=>{reached=resolve})
let release!:()=>void
const releaseRequest=new Promise<void>(resolve=>{release=resolve})
const endpoint=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  if(new URL(request.url).pathname==="/hold-prune"){
    persistReached();await continuePersist;return new Response("continue")
  }
  const body:any=await request.json(); calls.push(body)
  const n=calls.length
  if(n===5){reached();await releaseRequest}
  const args=n===1?{topic:"first",content:[{startId:"m0001",endId:"m0001",summary:"First summary."}]}:
    {topic:n===2?"second":"stale ID recovery",content:[{startId:"b1",endId:"b1",summary:"Gone."}]}
  // First summary must be long enough for the stock gain threshold on step 2.
  if(n===1)args.content[0]!.summary="First summary. ".repeat(200)
  const delta=n<=3?{role:"assistant",tool_calls:[{index:0,id:`call_${n}`,type:"function",function:{name:"prune",arguments:JSON.stringify(args)}}]}:{role:"assistant",content:"DONE"}
  const chunks=[{id:`mock-${n}`,object:"chat.completion.chunk",choices:[{index:0,delta,finish_reason:null}]},
    {id:`mock-${n}`,object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:n<=3?"tool_calls":"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}]
  return new Response(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}})
}})
// Force a real plugin replacement while the old tool executor is persisting.
// Restore the pristine bundle before reload; only this private copy is edited.
const bundle=path.join(cfg,"dcp/vendor/index.js")
const pristine=await Bun.file(bundle).text()
if(!pristine.includes("async persist(sessionId) {"))throw Error("Missing persist fixture seam")
await Bun.write(bundle,pristine.replace("async persist(sessionId) {",`async persist(sessionId) { await fetch(${JSON.stringify(`${endpoint.url}hold-prune`)});`))
await Bun.write(path.join(cfg,"opencode.jsonc"),JSON.stringify({
  providers:{fixture:{package:"@opencode/ai/providers/openai/chat",settings:{baseURL:`${endpoint.url}v1`,apiKey:"fixture"},models:{model:{limit:{context:168000,input:168000,output:8192}}}}},
  model:"fixture/model",plugins:[{package:"./dcp",options:{maxContextLimit:"60%"}},"./no-title"],
  compaction:{auto:false},permissions:[{action:"*",resource:"*",effect:"deny"},{action:"prune",resource:"*",effect:"allow"}]
}))
const env:any={...process.env,XDG_CONFIG_HOME:path.join(root,"config"),XDG_DATA_HOME:path.join(root,"data"),XDG_CACHE_HOME:path.join(root,"cache"),XDG_STATE_HOME:path.join(root,"state"),TMPDIR:root,OPENCODE_PASSWORD:"fixture",OPENCODE_DISABLE_PROJECT_CONFIG:"1"}
for(const k of ["OPENCODE_CONFIG","OPENCODE_CONFIG_CONTENT","OPENCODE_CONFIG_DIR","OPENCODE_DB","OPENCODE_SERVER","OPENCODE_PURE"])delete env[k]
const child=Bun.spawn([`${process.env.HOME}/.local/lib/opencode-v2/2.2.5/opencode`,"serve","--hostname","127.0.0.1","--port","0"],{cwd:root,env,stdout:"pipe",stderr:"pipe"})
let stderr="";const errors=(async()=>{for await(const c of child.stderr)stderr+=new TextDecoder().decode(c)})()
try{
  const reader=child.stdout.getReader();let out="",url=""
  while(!url){const r=await reader.read();if(r.done)throw Error(stderr);out+=new TextDecoder().decode(r.value);url=out.match(/server listening on (http:\/\/[^\s]+)/)?.[1]??""}
  const client=OpenCode.make({baseUrl:url,headers:{Authorization:`Basic ${btoa("opencode:fixture")}`}})
  await client.model.list({location:{directory:root}})
  const s=await client.session.create({location:{directory:root}})
  await client.session.prompt({sessionID:s.id,text:"Fixture history. ".repeat(3500),resume:true})
  await Promise.race([persisting,Bun.sleep(10000).then(()=>{throw Error("Prune did not reach its persistence boundary")})])
  await Bun.write(bundle,pristine)
  const replacing=fetch(`${url}/api/location/reload`,{method:"POST",headers:{Authorization:`Basic ${btoa("opencode:fixture")}`,"Content-Type":"application/json"},body:JSON.stringify({directory:root})})
  await Bun.sleep(500)
  releasePersist()
  if(!(await replacing).ok)throw Error("Plugin replacement during prune failed")
  await client.experimental.session.wait({sessionID:s.id})
  const records=calls.map((c,i)=>({dispatch:i+1,refs:[...JSON.stringify(c.messages).matchAll(/<dcp-message-id>([mb]\d+)<\/dcp-message-id>/g)].map(m=>m[1]),
    description_chars:c.tools?.find((t:any)=>t.function?.name==="prune")?.function?.description?.length,
    errors:c.messages.filter((m:any)=>m.role==="tool"&&JSON.stringify(m.content).includes("inactive compressed block"))}))
  const result={root,dispatches:calls.length,records}
  await Bun.write(path.join(root,"requests.json"),JSON.stringify(calls,null,2))
  if(process.env.DEBUG_DCP_TESTS)console.log(JSON.stringify(result,null,2))
  if(calls.length!==4||!records[1]?.refs.includes("b1")||records[2]?.refs.includes("b1")||!records[2]?.refs.includes("b2"))throw Error("DCP does not refresh active IDs after sequential prunes")
  const error=JSON.stringify(records[3]?.errors)
  if(!error.includes("b2")||!error.includes("active"))throw Error("RED: stale-ID error supplies no currently usable boundary or replacement navigation")
  if(!records[3]?.refs.includes("b2")||records[3]?.refs.includes("b3"))throw Error("Failed stale-ID call mutated compression state")
  // Verify the exact production reload operation against a held model request.
  // A reload must neither restart the server nor cancel an unrelated active turn.
  const started=Date.now()
  const prompting=client.session.prompt({sessionID:s.id,text:"Check reload safety",resume:true})
  await pendingRequest
  const waiting=client.experimental.session.wait({sessionID:s.id})
  const reload=fetch(`${url}/api/location/reload`,{method:"POST",headers:{Authorization:`Basic ${btoa("opencode:fixture")}`,"Content-Type":"application/json"},body:JSON.stringify({directory:root})})
  await new Promise(resolve=>setTimeout(resolve,500))
  release()
  if(!(await reload).ok)throw Error("Location reload failed")
  await prompting
  await waiting
  const history:any=await(await fetch(`${url}/api/session/${s.id}/message`,{headers:{Authorization:`Basic ${btoa("opencode:fixture")}`}})).json()
  if(!history.data?.some((m:any)=>m.type==="assistant"&&m.time.created>=started&&m.finish==="stop"&&m.content?.some((p:any)=>p.type==="text"&&p.text==="DONE")))throw Error("Reload cancelled the held active turn")
  if(child.exitCode!==null)throw Error("Reload restarted or stopped the private server")
}finally{release();releasePersist();child.kill();await child.exited;await errors;endpoint.stop(true)}
},60000)
