import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

async function fixture() {
  await mkdir(path.join(root, ".tmp"), { recursive: true })
  const target = await mkdtemp(path.join(root, ".tmp/install-test-"))
  await cp(path.join(root, "dcp"), target, { recursive: true })
  return target
}

function run(target: string, apply = false) {
  return Bun.spawnSync([
    process.execPath, path.join(root, "install.ts"), "--target", target,
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
