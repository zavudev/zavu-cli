// The import scanner that decides which files a deploy uploads.
//
// It was written for the opposite job: a Zavu function used to deploy as ONE
// file, and this found the relative imports that could not possibly resolve so
// the CLI could warn before the upload. Functions are trees now, so the same
// parse drives the walk instead — every specifier it finds is a file to send.
//
// The cases below are the ones that broke it, and they still matter. What DID
// change is the cost of being wrong. Flagging an import that was not one used
// to block a working deploy; now it uploads a file nothing imports, which the
// bundler drops. Missing one used to cost a stray warning; now it leaves a file
// behind and the build cannot resolve it. So the scanner errs generous, and the
// type-only cases below assert inclusion rather than exclusion.

import { describe, it, expect } from "vitest"
import { findRelativeImports } from "../projectFiles"

describe("findRelativeImports (project walk)", () => {
  it("finds a bare relative import", () => {
    expect(findRelativeImports(`import { helper } from "./helpers"`)).toEqual(["./helpers"])
  })

  it("finds parent-relative ones", () => {
    expect(findRelativeImports(`import x from "../shared/util.js"`)).toEqual(["../shared/util.js"])
  })

  it("finds require and dynamic import", () => {
    const found = findRelativeImports(`
      const a = require("./a")
      const b = await import("./b")
      import "./side-effect"
    `)
    expect(found.sort()).toEqual(["./a", "./b", "./side-effect"])
  })

  it("does not flag npm packages, which the build worker installs and bundles", () => {
    expect(
      findRelativeImports(`
        import OpenAI from "openai"
        import { defineAgent } from "@zavudev/functions"
        import fs from "node:fs"
      `),
    ).toEqual([])
  })

  it("ignores a path inside a comment", () => {
    expect(
      findRelativeImports(`
        // import { x } from "./nope"
        /* import y from "./also-nope" */
        import { defineAgent } from "@zavudev/functions"
      `),
    ).toEqual([])
  })

  it("does not trip on a path that is just text in a prompt", () => {
    // Agent prompts talk about file paths all the time. Flagging one would
    // block a deploy over a sentence.
    expect(
      findRelativeImports(`
        defineAgent({
          prompt: "When someone asks for the config, tell them it is at ./config.json",
        })
      `),
    ).toEqual([])
  })

  it("deduplicates the same import seen twice", () => {
    expect(
      findRelativeImports(`
        import { a } from "./shared"
        import { b } from "./shared"
      `),
    ).toEqual(["./shared"])
  })

  // The four below are what a review of this function found. The version that
  // shipped first stripped comments only, though its docstring claimed strings
  // too, and the test above passed because its prompt said "./config.json"
  // without a preceding `from`. A weaker case proving a stronger claim.

  it("does not flag an import written inside a prompt", () => {
    // Blocking a deploy over the text of a prompt is worse than the bug this
    // check exists for: there is no override flag, so the only way out is to
    // edit the prompt.
    expect(
      findRelativeImports(
        `defineAgent({ systemPrompt: 'When asked how to import, answer: import x from "./lib/x.js"' })`,
      ),
    ).toEqual([])
  })

  it("does not flag a require mentioned in a description", () => {
    expect(
      findRelativeImports(`defineTool({ description: "mentions require('./config') in text" })`),
    ).toEqual([])
  })

  it("follows import type as well", () => {
    // The bundler erases `import type` without reading the file, so uploading
    // it changes nothing about the output. Skipping it would: a project whose
    // types live in ./types would deploy fine until someone imported a value
    // from the same file, and then fail on a line nobody touched.
    expect(
      findRelativeImports(`
        import type { Ctx } from "./types"
        import { defineAgent } from "@zavudev/functions"
      `),
    ).toEqual(["./types"])
  })

  it("follows a value import that also carries a type", () => {
    expect(findRelativeImports(`import { type Ctx, helper } from "./helpers"`)).toEqual([
      "./helpers",
    ])
  })

  it("follows the other type-only forms", () => {
    expect(
      findRelativeImports(`import type {\n  A,\n  B,\n} from "./types"`),
    ).toEqual(["./types"])
    expect(findRelativeImports(`import { type A, type B } from './t'`)).toEqual(["./t"])
    expect(findRelativeImports(`export type { X } from './t'`)).toEqual(["./t"])
  })

  it("is not desynced by a regex literal containing a quote", () => {
    // The one that mattered most. `/["']/` used to open a string that ran to
    // the next quote, shifting everything after it by one, so a path named in
    // a PROMPT landed in import position and stopped a working deploy. Writing
    // the same class as `/['"]/` gave the opposite answer: same code, decided
    // by the order of two characters.
    expect(
      findRelativeImports(`import { defineAgent } from "@zavudev/functions"

const strip = (raw: string) => raw.replace(/["']/g, "")

defineAgent({ prompt: "say: import Zavu from './sdk' is wrong" })`),
    ).toEqual([])

    // And the mirror: a regex must not hide a real import either.
    expect(
      findRelativeImports(`const strip = (r: string) => r.replace(/['"]/g, "")\nimport { helper } from "./helpers"`),
    ).toEqual(["./helpers"])

    // `/*` inside a character class is not a comment.
    expect(
      findRelativeImports(`const re = /[/*]/\nimport { h } from "./helpers"`),
    ).toEqual(["./helpers"])
  })

  it("treats a template literal as opaque, nesting included", () => {
    // Reading `${...}` as code and resuming after it is what a parser does, and
    // getting the resume point wrong turns the rest of the template into code.
    expect(findRelativeImports('const s = `pre ${x} import y from "./z"`')).toEqual([])
    expect(
      findRelativeImports('const e = `Wrong: ${`import x from "./local"`}. Right: the package.`'),
    ).toEqual([])
    // The cost of that choice, written down: an import inside an interpolation
    // is missed. It reaches esbuild, which says so.
    expect(findRelativeImports('const m = `${await import("./plugin")}`')).toEqual([])
  })

  // Shapes an adversarial pass tried. All of these behave; they are here so a
  // future rewrite of the scanner has to keep behaving.

  it("survives a shebang and a byte order mark", () => {
    expect(findRelativeImports(`#!/usr/bin/env node\nimport x from "./real"`)).toEqual(["./real"])
    expect(findRelativeImports(`\uFEFFimport x from "./real"`)).toEqual(["./real"])
  })

  it("catches export-from and multiline imports", () => {
    expect(findRelativeImports(`export { y } from "../b"`)).toEqual(["../b"])
    expect(findRelativeImports(`import {\n  a,\n  b,\n} from "./multi"`)).toEqual(["./multi"])
    expect(findRelativeImports(`import x, { y } from "./e"`)).toEqual(["./e"])
  })

  it("is not fooled by a template literal or an escaped quote", () => {
    expect(findRelativeImports('const s = `pre ${x} import y from "./z"`')).toEqual([])
    expect(findRelativeImports(`const s = "he said \\"import x from './y'\\""`)).toEqual([])
  })

  it("is not fooled by division that looks like a comment", () => {
    expect(findRelativeImports(`const m = c /2\nimport x from "./real"`)).toEqual(["./real"])
  })

  it("still finds the import after a regex literal", () => {
    expect(findRelativeImports(`const re = /["']/g\nimport { a } from "./real"`)).toEqual([
      "./real",
    ])
    expect(
      findRelativeImports(
        `const q = /'/g\ndefineAgent({ prompt: "write: import x from './helpers'" })`,
      ),
    ).toEqual([])
  })

  it("is quiet on a real single-file agent", () => {
    expect(
      findRelativeImports(`
        import { defineAgent, defineTool } from "@zavudev/functions"
        defineAgent({ name: "Ada", provider: "zavu", model: "openai/gpt-4o-mini", prompt: "hi" })
        defineTool({
          name: "get_order_status",
          description: "Look up an order.",
          parameters: { type: "object", properties: {}, required: [] },
          handler: async () => ({ ok: true }),
        })
      `),
    ).toEqual([])
  })
})
