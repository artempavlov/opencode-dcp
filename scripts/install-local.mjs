import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Upgrade the existing vendored local installation without touching config or KV.
const target = process.argv[2]
if (!target || !path.isAbsolute(target)) throw new Error("Usage: node scripts/install-local.mjs /absolute/path/to/existing/dcp")
const root = fileURLToPath(new URL("../", import.meta.url))
const manifest = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"))
if (manifest.name !== "opencode-dcp-local") throw new Error("Not a known local DCP installation")
const wrapper = await readFile(path.join(target, "index.ts"), "utf8")
if (!wrapper.includes('"./vendor/index.js"')) throw new Error("Unexpected local DCP entrypoint")
const bundle = await readFile(path.join(root, "dist/index.js"), "utf8")
if (!bundle.includes('"opencode.dcp"') || !bundle.includes("session.revert.committed")) throw new Error("Build DCP before installing")
const source = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
await mkdir(path.join(target, "vendor"), { recursive: true })
await copyFile(path.join(root, "dist/index.js.map"), path.join(target, "vendor/index.js.map"))
await copyFile(path.join(root, "dist/index.js"), path.join(target, "vendor/index.js"))
await copyFile(path.join(root, "dist/tui.tsx"), path.join(target, "tui.tsx"))
await writeFile(path.join(target, "package.json"), JSON.stringify({ ...manifest, version: source.version }, null, 2) + "\n")
console.log(JSON.stringify({ target, version: source.version, configUnchanged: true }))
