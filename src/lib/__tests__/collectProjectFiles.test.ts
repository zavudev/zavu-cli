// Walking a project from its entrypoint.
//
// What gets uploaded is decided here, so the two failure modes both have to be
// pinned down: leaving behind a file the function needs (the build then fails
// to resolve it), and sweeping up files that are none of Zavu's business —
// tests, scratch work, and anything else that happens to share the directory.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { collectProjectFiles } from "../projectFiles"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zavu-collect-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const path = join(root, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, "utf8")
}

describe("collectProjectFiles", () => {
  it("follows relative imports transitively", async () => {
    await write("index.ts", `import { formatOrder } from "./lib/orders"\nexport default formatOrder`)
    await write("lib/orders.ts", `import { upper } from "./text"\nexport const formatOrder = upper`)
    await write("lib/text.ts", `export const upper = (s: string) => s.toUpperCase()`)

    const { files, entrypoint } = await collectProjectFiles(root, "index.ts")

    expect(entrypoint).toBe("index.ts")
    expect(Object.keys(files).sort()).toEqual(["index.ts", "lib/orders.ts", "lib/text.ts"])
  })

  it("leaves files nothing imports on your machine", async () => {
    await write("index.ts", `export default async () => 1`)
    await write("index.test.ts", `import handler from "./index"`)
    await write("scratch.ts", `console.log("wip")`)
    await write(".env", "SECRET=hunter2")

    const { files } = await collectProjectFiles(root, "index.ts")

    expect(Object.keys(files)).toEqual(["index.ts"])
  })

  it("resolves a directory import through its index", async () => {
    await write("index.ts", `import { db } from "./lib"\nexport default db`)
    await write("lib/index.ts", `export const db = 1`)

    const { files } = await collectProjectFiles(root, "index.ts")

    expect(Object.keys(files).sort()).toEqual(["index.ts", "lib/index.ts"])
  })

  it("uploads imported json but does not scan it for imports", async () => {
    // A JSON file's strings would otherwise be read as code: this one contains
    // text that looks exactly like an import.
    await write("index.ts", `import cfg from "./config.json"\nexport default cfg`)
    await write("config.json", `{ "note": "import x from './nope'" }`)

    const { files, warnings } = await collectProjectFiles(root, "index.ts")

    expect(Object.keys(files).sort()).toEqual(["config.json", "index.ts"])
    expect(warnings).toEqual([])
  })

  it("survives a cycle", async () => {
    await write("index.ts", `import { b } from "./b"\nexport const a = b`)
    await write("b.ts", `import { a } from "./index"\nexport const b = a`)

    const { files } = await collectProjectFiles(root, "index.ts")

    expect(Object.keys(files).sort()).toEqual(["b.ts", "index.ts"])
  })

  it("warns instead of failing when an import does not resolve", async () => {
    // The scanner is a heuristic. Refusing to deploy over its guess is how the
    // single-file era went wrong: a false alarm blocked a working deploy with
    // no override. Let the build be the one to say no.
    await write("index.ts", `import { x } from "./missing"\nexport default x`)

    const { files, warnings } = await collectProjectFiles(root, "index.ts")

    expect(Object.keys(files)).toEqual(["index.ts"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("./missing")
  })

  it("refuses to upload a file from outside the project, and says what to do", async () => {
    await write("index.ts", `import { shared } from "../outside/shared"\nexport default shared`)
    const sibling = join(root, "..", "outside")
    await mkdir(sibling, { recursive: true })
    await writeFile(join(sibling, "shared.ts"), `export const shared = 1`, "utf8")

    try {
      const { files, warnings } = await collectProjectFiles(root, "index.ts")

      expect(Object.keys(files)).toEqual(["index.ts"])
      expect(warnings[0]).toContain("outside the project directory")
      expect(warnings[0]).toContain("npm package")
    } finally {
      await rm(sibling, { recursive: true, force: true })
    }
  })

  it("keeps a custom entrypoint's own path as the key", async () => {
    await write("src/main.ts", `import { n } from "./nested/dep"\nexport default n`)
    await write("src/nested/dep.ts", `export const n = 42`)

    const { files, entrypoint } = await collectProjectFiles(root, "src/main.ts")

    expect(entrypoint).toBe("src/main.ts")
    expect(Object.keys(files).sort()).toEqual(["src/main.ts", "src/nested/dep.ts"])
  })

  it("stops rather than uploading a runaway tree", async () => {
    // Each file imports the next, so the walk would otherwise follow all of them.
    for (let i = 0; i < 12; i++) {
      await write(i === 0 ? "index.ts" : `f${i}.ts`, `import "./f${i + 1}"`)
    }
    await write("f12.ts", `export {}`)

    await expect(collectProjectFiles(root, "index.ts", { maxFiles: 5 })).rejects.toThrow(
      /more than 5 files/
    )
  })

  it("seeds generated files without trying to read them from disk", async () => {
    await write("index.ts", `export default 1`)

    const { files } = await collectProjectFiles(root, "index.ts", {
      extraFiles: { ".zavu/generated.ts": "export const gen = true" },
    })

    expect(Object.keys(files).sort()).toEqual([".zavu/generated.ts", "index.ts"])
  })
})
