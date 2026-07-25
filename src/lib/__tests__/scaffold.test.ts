import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeTsconfig, RUNTIME_DEV_DEPENDENCY, SCAFFOLD_GITIGNORE } from "../scaffold"

// A scaffolded project has to be workable the moment it lands: types resolve,
// `tsc` passes, `zavu fn invoke` can load the module. None of that is needed to
// deploy — which is exactly why it went unnoticed that a fresh scaffold opened
// with a red import on line 1.

describe("scaffold", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zavu-scaffold-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("declares the runtime so npm install makes the project resolve", async () => {
    // The published package is what gives the editor and tsc the module. There
    // is no tsconfig `paths` trick any more, so this declaration is load-bearing.
    expect(RUNTIME_DEV_DEPENDENCY["@zavudev/functions"]).toMatch(/^\^?\d+\.\d+\.\d+/)
  })

  it("declares it as a devDependency, not a runtime one", async () => {
    // The layer supplies it in production and the bundler marks it external, so
    // shipping it would be dead weight — and the Build Worker installs user deps
    // with --omit=dev, which keeps it out of the server-side install entirely.
    expect(Object.keys(RUNTIME_DEV_DEPENDENCY)).toContain("@zavudev/functions")
    // The tsconfig asks for node types; declaring them is what makes a fresh
    // scaffold compile at all.
    expect(Object.keys(RUNTIME_DEV_DEPENDENCY)).toContain("@types/node")
  })

  it("writes a tsconfig that typechecks a handler doing the obvious things", async () => {
    await writeTsconfig(dir)
    const tsconfig = JSON.parse(await readFile(join(dir, "tsconfig.json"), "utf8"))

    expect(tsconfig.compilerOptions.strict).toBe(true)
    expect(tsconfig.compilerOptions.noEmit).toBe(true)
    // Handlers read secrets from process.env and call fetch; without node types
    // the very first thing anyone writes fails to compile.
    expect(tsconfig.compilerOptions.types).toContain("node")
    expect(tsconfig.include).toContain("*.ts")
  })

  it("no longer maps the module through tsconfig paths", async () => {
    await writeTsconfig(dir)
    const tsconfig = JSON.parse(await readFile(join(dir, "tsconfig.json"), "utf8"))
    // `paths` silently stops working for anyone with their own tsconfig or a
    // tool that ignores it. A real dependency does not care.
    expect(tsconfig.compilerOptions.paths).toBeUndefined()
  })

  it("keeps .zavu out of .gitignore so the functionId travels with the repo", async () => {
    // There is no command to look a functionId up, so ignoring `.zavu/` left a
    // teammate who cloned the repo unable to deploy it.
    expect(SCAFFOLD_GITIGNORE).toContain("node_modules/")
    expect(SCAFFOLD_GITIGNORE).not.toContain(".zavu/")
  })

  it("is idempotent, so re-running it on a live project is safe", async () => {
    await writeTsconfig(dir)
    const first = await readFile(join(dir, "tsconfig.json"), "utf8")
    await writeTsconfig(dir)
    expect(await readFile(join(dir, "tsconfig.json"), "utf8")).toBe(first)
  })
})
