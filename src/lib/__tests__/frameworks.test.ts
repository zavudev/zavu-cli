// Tests for framework detection and the eve → Zavu compiler.
//
// The compile test goes end-to-end on purpose: it builds a real eve-layout
// fixture, compiles it with the real esbuild, then IMPORTS the produced bundle
// so the embedded compat layer runs against the real @zavudev/functions
// registry and the real zod (v3 — the same major the runtime layer ships).
// A string-assertion-only test would happily pass while the bundle crashes at
// the manifest probe, which is the exact failure this pipeline must never ship.

import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { readFileSync } from "node:fs"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  detectFramework,
  analyzeEveProject,
  generateEveEntry,
  compileEveProject,
  deriveAgentName,
} from "../frameworks"
import {
  EVE_COMPAT_SOURCE,
  EVE_SUPPORTED_AGENT_KEYS,
  EVE_AGENT_KEY_HINTS,
  extractEveAgentConfigEntries,
  classifyEveToolExport,
  eveToolFileWarning,
} from "../eveCompat"
import { parseRepoRef } from "../../commands/functions/import"
// The server-side twin of this compiler, used by the GitHub import path. Pure
// (its only import is the shared compat module), so it runs here unmodified —
// which is the point: the two paths are asserted equal below, not assumed.
import { analyzeEveFiles } from "../../../../../apps/dashboard/convex/lib/gitProject"

const cleanups: string[] = []

afterAll(async () => {
  for (const dir of cleanups) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * Empty the registry the compat layer registers into.
 *
 * Must clear IN PLACE. `@zavudev/functions` binds its module-level REGISTRY to
 * whatever `globalThis.__ZAVU_REGISTRY` held when it first loaded, so assigning
 * a fresh object here only orphans the SDK's reference: every later
 * defineAgent lands in the old object and the test reads an empty new one.
 */
function resetRegistry(): { agents: any[]; tools: any[] } {
  const g = globalThis as Record<string, any>
  const registry = (g.__ZAVU_REGISTRY = g.__ZAVU_REGISTRY || { agents: [], tools: [] })
  registry.agents.length = 0
  registry.tools.length = 0
  return registry
}

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zavu-fw-test-"))
  cleanups.push(dir)
  return dir
}

async function makeEveProject(withAgentTs = true): Promise<string> {
  const dir = await makeDir()
  await mkdir(join(dir, "agent", "tools"), { recursive: true })
  await writeFile(
    join(dir, "agent", "instructions.md"),
    "You are a test agent.\nUse `backticks` and ${interpolation} literally.\n",
    "utf8"
  )
  if (withAgentTs) {
    await writeFile(
      join(dir, "agent", "agent.ts"),
      [
        'import { defineAgent } from "eve"',
        "export default defineAgent({",
        '  model: "anthropic/claude-sonnet-5",',
        '  reasoning: "high",',
        "})",
        "",
      ].join("\n"),
      "utf8"
    )
  }
  await writeFile(
    join(dir, "agent", "tools", "get_weather.ts"),
    [
      'import { defineTool } from "eve/tools"',
      'import { z } from "zod"',
      "export default defineTool({",
      '  description: "Return weather for a city.",',
      "  inputSchema: z.object({",
      '    city: z.string().min(1).describe("City name"),',
      "    days: z.number().optional(),",
      "  }),",
      "  async execute({ city }) {",
      '    return { city, condition: "Sunny" }',
      "  },",
      "})",
      "",
    ].join("\n"),
    "utf8"
  )
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "weather-bot",
      type: "module",
      dependencies: { eve: "^0.5.0", zod: "^3.23.8" },
    }),
    "utf8"
  )
  return dir
}

describe("detectFramework", () => {
  it("detects a Zavu native project by index.ts", async () => {
    const dir = await makeDir()
    await writeFile(join(dir, "index.ts"), "export {}\n", "utf8")
    expect((await detectFramework(dir)).framework).toBe("zavu-native")
  })

  it("detects an eve project by agent/instructions.md", async () => {
    const dir = await makeEveProject()
    expect((await detectFramework(dir)).framework).toBe("eve")
  })

  it("prefers index.ts when both layouts exist", async () => {
    const dir = await makeEveProject()
    await writeFile(join(dir, "index.ts"), "export {}\n", "utf8")
    expect((await detectFramework(dir)).framework).toBe("zavu-native")
  })

  it("reports unknown when neither layout is present", async () => {
    const dir = await makeDir()
    expect((await detectFramework(dir)).framework).toBe("unknown")
  })
})

describe("analyzeEveProject", () => {
  it("lists tools by filename stem and reads instructions", async () => {
    const dir = await makeEveProject()
    const analysis = await analyzeEveProject(dir)
    expect(analysis.tools).toEqual([{ name: "get_weather", file: "agent/tools/get_weather.ts" }])
    expect(analysis.instructions).toContain("test agent")
    expect(analysis.hasAgentTs).toBe(true)
  })

  it("warns about every capability that will not run", async () => {
    const dir = await makeEveProject()
    await mkdir(join(dir, "agent", "schedules"), { recursive: true })
    await mkdir(join(dir, "agent", "sandbox"), { recursive: true })
    await mkdir(join(dir, "agent", "skills"), { recursive: true })
    await writeFile(join(dir, "agent", "skills", "research.md"), "Research first.", "utf8")
    const analysis = await analyzeEveProject(dir)
    const joined = analysis.warnings.join("\n")
    expect(joined).toContain("agent/schedules")
    expect(joined).toContain("agent/sandbox")
    expect(joined).toContain("agent/skills")
    // The static agent.ts scan catches unsupported config keys too.
    expect(joined).toContain("'reasoning'")
  })

  it("skips tool files with invalid names, loudly", async () => {
    const dir = await makeEveProject()
    await writeFile(join(dir, "agent", "tools", "bad name!.ts"), "export default {}\n", "utf8")
    const analysis = await analyzeEveProject(dir)
    expect(analysis.tools.map((t) => t.name)).toEqual(["get_weather"])
    expect(analysis.warnings.join("\n")).toContain("bad name!")
  })

  it("rejects a project with empty instructions", async () => {
    const dir = await makeDir()
    await mkdir(join(dir, "agent"), { recursive: true })
    await writeFile(join(dir, "agent", "instructions.md"), "  \n", "utf8")
    await expect(analyzeEveProject(dir)).rejects.toThrow(/empty/)
  })
})

// An agent.ts that declares more than the adapter understands: two keys we
// know about (name, model), one we used to deny-list (reasoning), one whole
// capability (voice), and one nobody has invented yet (wormhole). The last is
// the regression: under a deny-list it deployed in total silence.
const RICH_AGENT_TS = [
  'import { defineAgent } from "eve"',
  "export default defineAgent({",
  '  name: "Recepción Clínica Aurora",',
  '  model: "anthropic/claude-sonnet-5",',
  "  voice: {",
  '    ttsVoiceId: "aria",',
  "    speed: 1.1,",
  "  },",
  '  reasoning: "high",',
  "  wormhole: { enabled: true },",
  "})",
  "",
].join("\n")

async function withAgentTs(source: string): Promise<string> {
  const dir = await makeEveProject()
  await writeFile(join(dir, "agent", "agent.ts"), source, "utf8")
  return dir
}

/** The same project as a path→contents map, for the GitHub import path. */
async function asFileMap(agentTs: string): Promise<Map<string, string>> {
  return new Map<string, string>([
    ["package.json", JSON.stringify({ name: "weather-bot" })],
    ["agent/instructions.md", "You are a test agent.\n"],
    ["agent/agent.ts", agentTs],
    [
      "agent/tools/get_weather.ts",
      'import { defineTool } from "eve/tools"\nexport default defineTool({ execute() {} })',
    ],
  ])
}

const agentConfigWarnings = (warnings: string[]) =>
  warnings.filter((w) => w.startsWith("agent config"))

describe("eve agent.ts allow-list", () => {
  it("names every declared key it does not translate, including unknown ones", async () => {
    const analysis = await analyzeEveProject(await withAgentTs(RICH_AGENT_TS))
    const joined = analysis.warnings.join("\n")
    // The key nobody anticipated is the whole reason this is an allow-list.
    expect(joined).toContain("'wormhole'")
    expect(joined).toContain("'reasoning'")
    expect(joined).toContain("'voice'")
  })

  it("says out loud that a voice block ships as a text-only agent", async () => {
    const analysis = await analyzeEveProject(await withAgentTs(RICH_AGENT_TS))
    const voiceWarning = analysis.warnings.find((w) => w.includes("'voice'"))
    expect(voiceWarning).toBeDefined()
    expect(voiceWarning).toContain("TEXT ONLY")
    expect(voiceWarning).toContain("will not answer phone calls")
  })

  it("stays quiet about the keys it does translate", async () => {
    const analysis = await analyzeEveProject(await withAgentTs(RICH_AGENT_TS))
    for (const key of EVE_SUPPORTED_AGENT_KEYS) {
      expect(analysis.warnings.join("\n")).not.toContain("'" + key + "'")
    }
  })

  it("reads top-level keys only, never keys nested inside a value", async () => {
    const analysis = await analyzeEveProject(await withAgentTs(RICH_AGENT_TS))
    const joined = analysis.warnings.join("\n")
    // ttsVoiceId/speed/enabled live inside voice and wormhole.
    expect(joined).not.toContain("'ttsVoiceId'")
    expect(joined).not.toContain("'speed'")
    expect(joined).not.toContain("'enabled'")
  })

  it("warns once per key even when the file is scanned repeatedly", async () => {
    const analysis = await analyzeEveProject(await withAgentTs(RICH_AGENT_TS))
    const wormhole = analysis.warnings.filter((w) => w.includes("'wormhole'"))
    expect(wormhole).toHaveLength(1)
  })

  it("has nothing to say about a config it cannot read statically", async () => {
    // `defineAgent(cfg)` is opaque to a scanner; the runtime check still sees
    // the real object, so reporting nothing here is correct, not a miss.
    const dir = await withAgentTs(
      ['import { defineAgent } from "eve"', "const cfg = { wormhole: 1 }", "export default defineAgent(cfg)", ""].join("\n")
    )
    const analysis = await analyzeEveProject(dir)
    expect(agentConfigWarnings(analysis.warnings)).toEqual([])
  })

  it("scans a bare `export default {}` config too", () => {
    const entries = extractEveAgentConfigEntries('export default { model: "x", voice: { a: 1 } }')
    expect(entries.map((e) => e.key)).toEqual(["model", "voice"])
  })

  it("is not fooled by braces, colons, or keys inside strings and comments", () => {
    const entries = extractEveAgentConfigEntries(
      [
        "export default defineAgent({",
        '  model: "gpt: {not_a_key: 1}",',
        "  // commented: true",
        "  /* blocked: true */",
        "  handlers: [{ inner: 1 }, () => { local: 2 }],",
        "})",
      ].join("\n")
    )
    expect(entries.map((e) => e.key)).toEqual(["model", "handlers"])
  })
})

describe("a tool file must default-export defineTool", () => {
  const writeTool = async (dir: string, source: string) => {
    await writeFile(join(dir, "agent", "tools", "check_return_window.ts"), source, "utf8")
  }

  it("does not count a plain object as a tool, and says which file", async () => {
    // The exact shape that deployed green while syncing zero tools: the report
    // promised the tool, reconcile created nothing, and the only trace was a
    // stderr line from the local runtime.
    const dir = await makeEveProject()
    await writeTool(
      dir,
      [
        "export const inputSchema = z.object({ orderId: z.string() })",
        'export default { description: "...", inputSchema, execute: async () => ({}) }',
      ].join("\n")
    )
    const analysis = await analyzeEveProject(dir)
    expect(analysis.tools.map((t) => t.name)).toEqual(["get_weather"])
    const warning = analysis.warnings.find((w) => w.includes("check_return_window"))
    expect(warning).toContain("plain object")
    expect(warning).toContain("will NOT become a tool")
  })

  it("does not count a file with no default export", async () => {
    const dir = await makeEveProject()
    await writeTool(dir, "export const helper = 1")
    const analysis = await analyzeEveProject(dir)
    expect(analysis.tools.map((t) => t.name)).toEqual(["get_weather"])
    expect(analysis.warnings.find((w) => w.includes("check_return_window"))).toContain(
      "no default export"
    )
  })

  it("keeps shapes only the runtime can judge, rather than dropping a working tool", async () => {
    for (const source of [
      'import { defineTool } from "eve/tools"\nconst t = defineTool({ execute() {} })\nexport default t',
      'import { defineTool as dt } from "eve/tools"\nexport default dt({ execute() {} })',
      'export { default } from "./shared"',
      'import { defineTool } from "eve/tools"\nexport default { ...defineTool({ execute() {} }) }',
    ]) {
      const dir = await makeEveProject()
      await writeTool(dir, source)
      const analysis = await analyzeEveProject(dir)
      expect(analysis.tools.map((t) => t.name)).toContain("check_return_window")
      expect(analysis.warnings.find((w) => w.includes("check_return_window"))).toBeUndefined()
    }
  })

  // Every shape below is settled by reading it: either it cannot carry the
  // marker defineTool() returns, or it plainly does. Only genuinely ambiguous
  // shapes are allowed to stay silent, and each one here is not ambiguous.
  const CANNOT_BE_A_TOOL: Array<[string, string]> = [
    ["a plain object", 'export default { description: "x", execute: async () => ({}) }'],
    [
      "a plain object in a file that imports defineTool",
      'import { defineTool } from "eve/tools"\nexport default { execute: async () => ({}) }',
    ],
    // The word "defineTool" appearing as TEXT proves nothing. Only a real
    // top-level spread can carry the marker into a literal, so neither a
    // string nor a comment may buy the file its silence.
    [
      "a plain object that merely mentions defineTool in a string",
      'export default { description: "Not declared with defineTool, so it is skipped.", execute: async () => ({}) }',
    ],
    [
      "a plain object mentioning defineTool in a line comment",
      "export default {\n  // not built with defineTool on purpose\n  execute: async () => ({}),\n}",
    ],
    [
      "a plain object mentioning defineTool in a block comment",
      "export default {\n  /* defineTool would be better here */\n  execute: async () => ({}),\n}",
    ],
    [
      "a plain object under a comment mentioning defineTool",
      "// TODO: migrate to defineTool\nexport default { execute: async () => ({}) }",
    ],
    // The mirror image: text that merely LOOKS like a spread must not be read
    // as one, or the file would buy silence with a string.
    [
      "a plain object with a spread-looking string",
      'export default { description: "spread it like ...defineTool", execute: async () => ({}) }',
    ],
    [
      "a plain object with a spread-looking comment",
      "export default {\n  // like ...defineTool({})\n  execute: async () => ({}),\n}",
    ],
    ["an object with a type assertion", "export default { execute: async () => ({}) } as any"],
    ["an array", "export default [1, 2]"],
    ["a string", 'export default "nope"'],
    ["a class", "export default class Tool {}"],
    ["a function", "export default function tool() {}"],
    ["an async function", "export default async function tool() {}"],
    ["nothing (no default export)", "export const helper = 1"],
    ["a CommonJS module.exports", "module.exports = { execute: async () => ({}) }"],
  ]

  const CAN_BE_A_TOOL: Array<[string, string]> = [
    ["defineTool directly", 'import { defineTool } from "eve/tools"\nexport default defineTool({ execute() {} })'],
    ["a spread of defineTool", 'import { defineTool } from "eve/tools"\nexport default { ...defineTool({ execute() {} }) }'],
    ["an identifier", 'import { defineTool } from "eve/tools"\nconst t = defineTool({ execute() {} })\nexport default t'],
    ["an aliased import", 'import { defineTool as dt } from "eve/tools"\nexport default dt({ execute() {} })'],
    ["a re-export", 'export { default } from "./shared"'],
    ["a user's own wrapper", 'import { make } from "./make"\nexport default make({ execute() {} })'],
    // A real spread of anything could be carrying the marker.
    ["a spread of a variable", 'import base from "./base"\nexport default { ...base, description: "x" }'],
  ]

  it.each(CANNOT_BE_A_TOOL)("warns when the default export is %s", (_label, source) => {
    expect(eveToolFileWarning("agent/tools/x.ts", classifyEveToolExport(source))).toContain(
      "will NOT become a tool"
    )
  })

  it.each(CAN_BE_A_TOOL)("stays silent when the default export is %s", (_label, source) => {
    expect(eveToolFileWarning("agent/tools/x.ts", classifyEveToolExport(source))).toBeUndefined()
  })

  it("keeps the count in the report equal to what actually registers", async () => {
    // The invariant the bug broke: whatever the report counts is what the
    // bundle registers. Proven by running the bundle, not by reading strings.
    const registry = resetRegistry()
    const dir = await makeEveProject()
    await writeTool(dir, 'export default { description: "nope", execute: async () => ({}) }')
    const res = await compileEveProject(dir, { senderId: "sndr_test" })

    const here = dirname(fileURLToPath(import.meta.url))
    const runDir = join(here, `.bundle-tools-${Date.now()}`)
    cleanups.push(runDir)
    await mkdir(runDir, { recursive: true })
    const bundlePath = join(runDir, "bundle.mjs")
    await writeFile(bundlePath, res.sourceCode, "utf8")
    await import(pathToFileURL(bundlePath).href)

    expect(res.analysis.tools).toHaveLength(1)
    expect(registry.tools).toHaveLength(1)
    expect(registry.tools[0].name).toBe("get_weather")
  })

  it("reports the same tool warnings from the CLI and the GitHub import path", async () => {
    const broken = 'export default { description: "...", execute: async () => ({}) }'
    const dir = await makeEveProject()
    await writeTool(dir, broken)
    const local = await analyzeEveProject(dir)

    const files = await asFileMap(RICH_AGENT_TS)
    files.set("agent/tools/check_return_window.ts", broken)
    const remote = analyzeEveFiles(files)

    const toolWarnings = (ws: string[]) => ws.filter((w) => w.startsWith("tool file"))
    expect(toolWarnings(remote.warnings)).toEqual(toolWarnings(local.warnings))
    expect(toolWarnings(remote.warnings)).toHaveLength(1)
  })
})

describe("the two compat copies", () => {
  it("are byte-identical", () => {
    // Both deploy paths import the allow-list, the static scanners, and the
    // embedded runtime from this module. Two copies exist because the CLI ships
    // standalone and Convex functions cannot import outside convex/; nothing
    // makes them agree except this test.
    const here = dirname(fileURLToPath(import.meta.url))
    const cli = readFileSync(join(here, "../eveCompat.ts"), "utf8")
    const server = readFileSync(
      join(here, "../../../../../apps/dashboard/convex/lib/eveCompatSource.ts"),
      "utf8"
    )
    expect(server).toBe(cli)
  })
})

describe("eve agent name", () => {
  it("honours the name declared in agent.ts over the package name", async () => {
    const dir = await withAgentTs(RICH_AGENT_TS)
    const analysis = await analyzeEveProject(dir)
    expect(analysis.declaredAgentName).toBe("Recepción Clínica Aurora")
    // package.json says "weather-bot"; the declaration wins.
    const res = await compileEveProject(dir)
    expect(res.agentName).toBe("Recepción Clínica Aurora")
  })

  it("falls back to the package name when agent.ts declares none", async () => {
    const dir = await makeEveProject()
    const analysis = await analyzeEveProject(dir)
    expect(analysis.declaredAgentName).toBeUndefined()
    expect((await compileEveProject(dir)).agentName).toBe("weather-bot")
  })

  it("registers the declared name when the bundle actually runs", async () => {
    const registry = resetRegistry()
    const dir = await withAgentTs(RICH_AGENT_TS)
    const res = await compileEveProject(dir, { senderId: "sndr_test" })
    const here = dirname(fileURLToPath(import.meta.url))
    const runDir = join(here, `.bundle-name-${Date.now()}`)
    cleanups.push(runDir)
    await mkdir(runDir, { recursive: true })
    const bundlePath = join(runDir, "bundle.mjs")
    await writeFile(bundlePath, res.sourceCode, "utf8")
    await import(pathToFileURL(bundlePath).href)

    expect(registry.agents).toHaveLength(1)
    expect(registry.agents[0].name).toBe("Recepción Clínica Aurora")
  })
})

describe("CLI and GitHub import agree", () => {
  it("produces the same agent-config warnings and name from both paths", async () => {
    const local = await analyzeEveProject(await withAgentTs(RICH_AGENT_TS))
    const remote = analyzeEveFiles(await asFileMap(RICH_AGENT_TS))
    expect(agentConfigWarnings(remote.warnings)).toEqual(agentConfigWarnings(local.warnings))
    expect(agentConfigWarnings(remote.warnings).length).toBeGreaterThan(0)
    expect(remote.declaredAgentName).toBe(local.declaredAgentName)
  })
})

describe("embedded runtime allow-list", () => {
  it("matches the allow-list the static scan uses", () => {
    const match = EVE_COMPAT_SOURCE.match(/const SUPPORTED_AGENT_KEYS = \[([^\]]*)\]/)
    expect(match).not.toBeNull()
    const embedded = match![1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
    expect(embedded).toEqual([...EVE_SUPPORTED_AGENT_KEYS])
  })

  it("carries the same hint text as the static scan", () => {
    const start = EVE_COMPAT_SOURCE.indexOf("const AGENT_KEY_HINTS")
    expect(start).toBeGreaterThan(-1)
    const block = EVE_COMPAT_SOURCE.slice(start)
    const embeddedKeys = [...block.slice(0, block.indexOf("\n}")).matchAll(/\n {2}(\w+):/g)].map(
      (m) => m[1]
    )
    expect(embeddedKeys.sort()).toEqual(Object.keys(EVE_AGENT_KEY_HINTS).sort())
    for (const hint of Object.values(EVE_AGENT_KEY_HINTS)) {
      expect(EVE_COMPAT_SOURCE).toContain(hint)
    }
  })
})

describe("generateEveEntry", () => {
  it("escapes instructions airtight and inlines an explicit sender", async () => {
    const dir = await makeEveProject()
    const analysis = await analyzeEveProject(dir)
    const entry = generateEveEntry(analysis, { agentName: "Weather Bot", senderId: "sndr_1" })
    // JSON.stringify escaping: raw markdown with backticks/${ must be inert.
    expect(entry).toContain(JSON.stringify(analysis.instructions))
    expect(entry).toContain('"sndr_1"')
    expect(entry).toContain('__registerEveTool("get_weather", __tool_0)')
  })

  it("falls back to the SENDER_ID secret when no sender is given", async () => {
    const dir = await makeEveProject()
    const analysis = await analyzeEveProject(dir)
    const entry = generateEveEntry(analysis, { agentName: "Weather Bot" })
    expect(entry).toContain("process.env.SENDER_ID")
  })
})

describe("deriveAgentName", () => {
  it("uses the package name, unscoped and sanitized", () => {
    expect(deriveAgentName("/tmp/x", "@acme/support-bot")).toBe("support-bot")
    expect(deriveAgentName("/tmp/my-agent")).toBe("my-agent")
  })
})

describe("compileEveProject (end to end)", () => {
  beforeEach(() => {
    // The compat layer registers into the shared global registry; each test
    // needs a clean one.
    resetRegistry()
  })

  it("produces one bundle with no eve imports left, and drops eve from deps", async () => {
    const dir = await makeEveProject()
    const res = await compileEveProject(dir, { senderId: "sndr_test" })
    expect(res.sourceCode).toContain("__registerEveTool")
    // Every `eve` / `eve/*` import must have been aliased into the bundle.
    expect(res.sourceCode).not.toMatch(/from\s*["']eve["']/)
    expect(res.sourceCode).not.toMatch(/from\s*["']eve\//)
    expect(res.dependencies).not.toHaveProperty("eve")
    expect(res.dependencies).toHaveProperty("zod")
    expect(res.agentName).toBe("weather-bot")
  })

  it("registers a working agent and tool when the bundle actually runs", async () => {
    const dir = await makeEveProject()
    const res = await compileEveProject(dir, { senderId: "sndr_test" })

    // Import the bundle from inside the package so bare imports
    // (@zavudev/functions, zod) resolve against the workspace node_modules —
    // the same externals the runtime layer provides in production.
    const here = dirname(fileURLToPath(import.meta.url))
    const runDir = join(here, `.bundle-run-${Date.now()}`)
    cleanups.push(runDir)
    await mkdir(runDir, { recursive: true })
    const bundlePath = join(runDir, "bundle.mjs")
    await writeFile(bundlePath, res.sourceCode, "utf8")
    await import(pathToFileURL(bundlePath).href)

    const registry = (globalThis as Record<string, any>).__ZAVU_REGISTRY
    expect(registry.agents).toHaveLength(1)
    const agent = registry.agents[0]
    expect(agent.name).toBe("weather-bot")
    expect(agent.provider).toBe("zavu")
    expect(agent.model).toBe("anthropic/claude-sonnet-5")
    expect(agent.senderId).toBe("sndr_test")
    expect(agent.systemPrompt).toContain("test agent")
    // The raw markdown survived escaping byte for byte.
    expect(agent.systemPrompt).toContain("${interpolation}")

    expect(registry.tools).toHaveLength(1)
    const tool = registry.tools[0]
    expect(tool.name).toBe("get_weather")
    // Zod v3 schema converted by the self-contained walker.
    expect(tool.parameters.type).toBe("object")
    expect(tool.parameters.properties.city).toMatchObject({
      type: "string",
      minLength: 1,
      description: "City name",
    })
    expect(tool.parameters.properties.days).toMatchObject({ type: "number" })
    expect(tool.parameters.required).toEqual(["city"])

    // The wrapped handler executes the eve `execute` with an adapted ctx.
    const out = await tool.handler({ city: "Santiago" }, { log: () => {}, messageId: "m1" })
    expect(out).toEqual({ city: "Santiago", condition: "Sunny" })
  })
})

describe("parseRepoRef", () => {
  it("parses owner/repo", () => {
    expect(parseRepoRef("acme/bot")).toEqual({ owner: "acme", repo: "bot", ref: undefined })
  })
  it("parses owner/repo#ref", () => {
    expect(parseRepoRef("acme/bot#staging")).toEqual({ owner: "acme", repo: "bot", ref: "staging" })
  })
  it("parses github.com URLs with .git and tree paths", () => {
    expect(parseRepoRef("https://github.com/acme/bot.git")).toEqual({
      owner: "acme",
      repo: "bot",
      ref: undefined,
    })
    expect(parseRepoRef("https://github.com/acme/bot/tree/main/apps/agent")).toEqual({
      owner: "acme",
      repo: "bot",
      ref: "main",
    })
    expect(parseRepoRef("git@github.com:acme/bot.git")).toEqual({
      owner: "acme",
      repo: "bot",
      ref: undefined,
    })
  })
  it("rejects garbage", () => {
    expect(() => parseRepoRef("not-a-repo")).toThrow(/Could not parse/)
    expect(() => parseRepoRef("https://example.com/acme/bot")).toThrow(/Could not parse/)
  })
})
