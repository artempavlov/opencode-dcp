import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

async function fixture() {
  await mkdir(path.join(root, ".tmp"), { recursive: true })
  const target = await mkdtemp(path.join(root, ".tmp/install-test-"))
  await cp(path.join(root, "dcp"), target, { recursive: true })
  return target
}

function run(target: string, apply = false, installer = path.join(root, "install.ts")) {
  return Bun.spawnSync([
    process.execPath, installer, "--target", target,
    ...(apply ? ["--apply"] : []),
  ], { cwd: root })
}

test("installer defaults to a read-only plan", async () => {
  const target = await fixture()
  const file = path.join(target, "vendor/index.js")
  const before = (await stat(file)).mtimeMs
  const result = run(target)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).apply).toBe(false)
  expect((await stat(file)).mtimeMs).toBe(before)
})

test("installing an identical version is a no-op", async () => {
  const target = await fixture()
  const file = path.join(target, "vendor/index.js")
  const before = (await stat(file)).mtimeMs
  const result = run(target, true)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).files.every((file: any) => !file.changed)).toBe(true)
  expect((await stat(file)).mtimeMs).toBe(before)
})

test("installer refuses unrelated edits before changing any target file", async () => {
  const target = await fixture()
  const file = path.join(target, "vendor/index.js")
  const readme = await readFile(path.join(target, "README.md"), "utf8")
  await writeFile(file, "Unrelated user changes")
  expect(run(target, true).exitCode).not.toBe(0)
  expect(await readFile(file, "utf8")).toBe("Unrelated user changes")
  expect(await readFile(path.join(target, "README.md"), "utf8")).toBe(readme)
})

test("installer accepts a recognized earlier release without relaxing fingerprint checks", async () => {
  const target = await fixture()
  const staging = await mkdtemp(path.join(root, ".tmp/install-upgrade-"))
  await cp(path.join(root, "dcp"), path.join(staging, "dcp"), { recursive: true })
  await cp(path.join(root, "install.ts"), path.join(staging, "install.ts"))
  const hashes: Record<string, string[]> = {}
  for (const name of ["vendor/index.js", "README.md", "package.json"]) {
    const old = `Recognized fixture version: ${name}`
    await writeFile(path.join(target, name), old)
    hashes[name] = ["another-known-version", createHash("sha256").update(old).digest("hex")]
  }
  await writeFile(path.join(staging, "upstream-fingerprints.json"), JSON.stringify(hashes))
  const result = run(target, true, path.join(staging, "install.ts"))
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).files.every((f: any) => f.changed)).toBe(true)
  for (const name of Object.keys(hashes)) {
    expect(await readFile(path.join(target, name))).toEqual(await readFile(path.join(root, "dcp", name)))
  }
})
