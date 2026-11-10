import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeTsconfig, RUNTIME_DEV_DEPENDENCY, SCAFFOLD_GITIGNORE } from "../scaffold"

// A scaffolded project has to be workable the moment it lands: types resolve,
// `tsc` passes, `npx zavudev fn invoke` can load the module. None of that is needed to
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
    // Subdirectories, not just the root. A function deploys every file its
    // entrypoint imports, so `lib/orders.ts` is part of the project; a
    // root-only glob left it outside the program, where the editor treated it
    // as a loose file and `tsc --noEmit` never opened it.
    expect(tsconfig.include).toContain("**/*.ts")
    expect(tsconfig.exclude).toContain("node_modules")
  })

  it("pins the runtime package to the minor that is actually published", async () => {
    // `^0.1.0` cannot resolve to 0.2.0: under semver a caret on a 0.x version
    // is locked to that minor. The scaffold therefore installed declarations
    // that predated defineFlow, knowledge bases and multi-sender agents, and
    // code copied straight out of the docs failed to typecheck against a
    // runtime that supports it. Compare against the package in this repo,
    // which is what gets published.
    const pkg = JSON.parse(
      await readFile(
        new URL("../../../../zavu-functions/package.json", import.meta.url),
        "utf8"
      )
    )
    const range = RUNTIME_DEV_DEPENDENCY["@zavudev/functions"]
    const [rMajor, rMinor] = range.replace(/^[^\d]*/, "").split(".").map(Number)
    const [pMajor, pMinor] = pkg.version.split(".").map(Number)

    expect(rMajor).toBe(pMajor)
    // Below 1.0 a caret does not cross minors, so the minor has to match too.
    if (pMajor === 0) expect(rMinor).toBe(pMinor)
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
