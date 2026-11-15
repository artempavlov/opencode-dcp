import {createHash} from "node:crypto"
import {readFile,writeFile,rename,unlink,mkdir} from "node:fs/promises"
import path from "node:path"
import os from "node:os"
const root=import.meta.dir
const args=process.argv.slice(2)
const flag=args.indexOf("--target")
const target=flag>=0?path.resolve(args[flag+1]!):path.join(os.homedir(),".local/share/opencode-v2/config/opencode/local-plugins/dcp")
const baseline=JSON.parse(await readFile(path.join(root,"upstream-fingerprints.json"),"utf8")) as Record<string,string>
const sha=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex")
const files=await Promise.all(Object.keys(baseline).map(async name=>{
 const source=await readFile(path.join(root,"dcp",name));const current=await readFile(path.join(target,name))
 const from=sha(current),to=sha(source)
 if(from!==baseline[name]&&from!==to)throw Error(`Refusing to overwrite unrecognized changes in ${name}`)
 return {name,source,from,to,changed:from!==to}
}))
console.log(JSON.stringify({target,apply:args.includes("--apply"),files:files.map(({name,from,to,changed})=>({name,from,to,changed}))},null,2))
if(args.includes("--apply"))for(const file of files){
 if(!file.changed)continue
 const dest=path.join(target,file.name)
 // Re-check at the write boundary to preserve changes made after the plan.
 if(sha(await readFile(dest))!==file.from)throw Error(`File changed while planning: ${file.name}`)
 await mkdir(path.dirname(dest),{recursive:true})
 const staged=`${dest}.dcp-recovery-${process.pid}-${Date.now()}`
 try{await writeFile(staged,file.source,{flag:"wx"});await rename(staged,dest)}
 finally{await unlink(staged).catch(()=>{})}
}
