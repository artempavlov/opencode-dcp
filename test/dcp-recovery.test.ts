import {expect,test} from "bun:test"
import {readFileSync} from "node:fs"
const source=readFileSync(new URL("../dcp/vendor/index.js",import.meta.url),"utf8")
  .split("var index_default = Plugin.define")[0]!.replace(/^import .*;\n/gm,"")
const api=new Function(`${source}\nreturn {boundaryToIndex,createSessionState,RefRegistry,createContextHook,scanTranscript,resolveOptions,UsageTracker,resolvePlans}`)()
function fixture(){
 const state=api.createSessionState("recovery")
 state.blocks={
  "1":{blockId:1,active:false,coveredKeys:["old"]},
  "9":{blockId:9,active:true,coveredKeys:["old","extra"]},
  "3":{blockId:3,active:true,coveredKeys:["other"]},
 }
 state.activeBlockIds=[3,9]
 const runtime={state,refs:new api.RefRegistry()}
 runtime.refs.project(["user-a","user-b"])
 return {runtime,keys:new Map([["user-a",1],["user-b",3]]),blocks:new Map([[9,0],[3,2]])}
}
function failure(id:string){
 const f=fixture();const before=JSON.stringify(f.runtime.state)
 let message=""
 try{api.boundaryToIndex(id,f.keys,f.blocks,f.runtime,"startId")}catch(e:any){message=e.message}
 expect(JSON.stringify(f.runtime.state)).toBe(before)
 return message
}
test("inactive ID rejects without mutation and supplies current transcript-order boundaries",()=>{
 const m=failure("b1")
 expect(m).toContain("references an inactive compressed block")
 expect(m).toContain("Active compressed blocks: b9, b3")
 expect(m).toContain("Raw messages: m0001, m0002")
 expect(m).toContain("now covered by b9")
 expect(m).toContain("NOT permission to substitute")
 expect(m).toContain("No compression was performed")
})
test("unknown IDs and expired raw refs receive current navigation without invented parents",()=>{
 for(const id of ["b999","m0999"]){
  const m=failure(id)
  expect(m).toContain("CURRENT VALID BOUNDARIES")
  expect(m).not.toContain("now covered by")
 }
})
test("valid ID remains an ordinary exact resolution",()=>{
 const f=fixture()
 expect(api.boundaryToIndex("b9",f.keys,f.blocks,f.runtime,"startId")).toBe(0)
 expect(api.boundaryToIndex("m0002",f.keys,f.blocks,f.runtime,"endId")).toBe(3)
})
test("partial overlap is not reported as a covering parent",()=>{
 const f=fixture();f.runtime.state.blocks["1"].coveredKeys=["old","not-in-parent"]
 expect(()=>api.boundaryToIndex("b1",f.keys,f.blocks,f.runtime,"startId")).toThrow()
 let message="";try{api.boundaryToIndex("b1",f.keys,f.blocks,f.runtime,"startId")}catch(e:any){message=e.message}
 expect(message).not.toContain("now covered by")
})
test("existing tail reminder advertises active IDs only, without changing tools or system schema",async()=>{
 const messages=[{id:"old",role:"user",content:[{type:"text",text:"Old"}]},
  {id:"new",role:"user",content:[{type:"text",text:"Current long task ".repeat(1800)}]}]
 const state=api.createSessionState("catalogue")
 const idx=api.scanTranscript(messages)
 state.blocks={"1":{blockId:1,active:false,coveredKeys:[idx.keys[0]]},
  "2":{blockId:2,active:true,coveredKeys:[idx.keys[0]],coveredToolIds:[],anchorKey:idx.keys[1],
   summary:"[Compressed conversation section]\nCurrent summary\n<dcp-message-id>b2</dcp-message-id>",summaryTokens:15,compressedTokens:30}}
 state.activeBlockIds=[2]
 const runtime={state,refs:new api.RefRegistry()}
 const store={ensure:async()=>runtime,reconcile:async()=>{},peek:()=>runtime,persist:async()=>{}}
 const warnings:any[]=[]
 const hook=api.createContextHook({config:api.resolveOptions({maxContextLimit:"1%",nudgeFrequency:1},()=>{}),store,
  mirror:{update:()=>{}},usage:new api.UsageTracker(),isSubAgent:async()=>false,catalogContextLimit:async()=>168000,
  logger:{warn:(...x:any[])=>warnings.push(x),debug:()=>{}}})
 const tools={prune:{description:"unchanged",inputSchema:{type:"object"}}}
 const event={sessionID:"catalogue",agent:"build",model:{providerID:"fixture",id:"model"},messages,system:[],tools}
 await hook(event)
 expect(warnings).toEqual([])
 const tail=JSON.stringify(event.messages.at(-1))
 expect(tail).toContain("CURRENT ACTIVE COMPRESSED BLOCKS (earliest to latest)")
 expect(tail).toContain("1. b2")
 expect(tail).toContain("Do not sort b-IDs numerically")
 expect(tail).not.toContain("b1")
 expect(tail).toContain("not an instruction to prune again")
 expect(tools).toEqual({prune:{description:"unchanged",inputSchema:{type:"object"}}})
})
test("reversed ranges provide actual visible positions, not a silent reversal",()=>{
 const messages=[{id:"a",role:"user",content:[{type:"text",text:"A"}]},{id:"b",role:"user",content:[{type:"text",text:"B"}]}]
 const index=api.scanTranscript(messages)
 const state=api.createSessionState("order")
 state.blocks={"9":{blockId:9,active:true,coveredKeys:[index.keys[0]],anchorKey:index.keys[1]},
  "3":{blockId:3,active:true,coveredKeys:[index.keys[1]],anchorKey:"tail"}}
 state.activeBlockIds=[9,3]
 const runtime={state,refs:new api.RefRegistry()}
 const before=JSON.stringify(state)
 let message=""
 try{api.resolvePlans({topic:"wrong order",content:[{startId:"b3",endId:"b9",summary:"No"}]},index,runtime)}catch(e:any){message=e.message}
 expect(message).toContain("visible positions are 2 and 1")
 expect(message).toContain("Active compressed blocks: b9, b3")
 expect(JSON.stringify(state)).toBe(before)
})
