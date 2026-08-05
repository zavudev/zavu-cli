// Framework detection and the eve → Zavu compiler.
//
// `zavudev deploy` and `zavudev import` call into here to answer two
// questions: "what kind of agent project is this directory?" and, for an
// eve-layout project, "give me a single sourceCode string the existing deploy
// pipeline can ship". The Build Worker re-bundles whatever we send with the
// project's npm dependencies installed, so the client-side compile only has to
// flatten LOCAL files into one module — every bare package import stays
// external.

import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises"
import { join, basename } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import {
  EVE_COMPAT_SOURCE,
  EVE_COMPAT_FILENAME,
  extractEveAgentConfigEntries,
  eveAgentConfigWarnings,
  eveDeclaredAgentName,
  classifyEveToolExport,
  eveToolFileWarning,
  type EveToolExportShape,
} from "./eveCompat"
import { ui, cli } from "./ui"

export type Framework = "zavu-native" | "eve" | "unknown"

export interface DetectionResult {
  framework: Framework
  /** Human-readable evidence, e.g. "agent/instructions.md present". */
  evidence: string
}

// eve capability directories that have no Zavu equivalent. Each one found in
// the project produces an explicit warning — a capability silently dropped is
// the failure mode this whole layer exists to avoid.
const EVE_UNSUPPORTED_DIRS: Array<{ dir: string; hint: string }> = [
  { dir: "agent/channels", hint: "Zavu's senders are the channels; channel files never run here" },
  {
    dir: "agent/schedules",
    hint: "use a Zavu cron trigger instead (fn triggers add --events cron)",
  },
  { dir: "agent/subagents", hint: "subagents are not supported; run on eve's runtime with the Zavu channel if you need them" },
  { dir: "agent/sandbox", hint: "sandboxed compute is not supported on Zavu" },
  { dir: "agent/connections", hint: "connections are not supported; call APIs from a tool handler instead" },
  { dir: "evals", hint: "evals do not run on Zavu; keep running them with eve locally" },
]

export interface EveToolFile {
  /** Model-visible tool name, derived from the filename stem (eve convention). */
  name: string
  /** Path relative to the project root, e.g. "agent/tools/get_weather.ts". */
  file: string
}

export interface EveAnalysis {
  /** Contents of agent/instructions.md. */
  instructions: string
  hasAgentTs: boolean
  tools: EveToolFile[]
  /** Skill files found under agent/skills (not synced — reported honestly). */
  skills: string[]
  /**
   * `name` declared in agent.ts, when the static scan could read it. The
   * runtime honours it over the package.json-derived name; this is here so the
   * report can say what the agent will be called before anything ships.
   */
  declaredAgentName?: string
  /** One line per capability that will NOT run on Zavu. */
  warnings: string[]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Decide what kind of project a directory holds.
 *
 * A root `index.ts` wins over an `agent/` directory: the future v2 layout will
 * pair `agent/` with a Zavu config, and a repo that already has a Zavu
 * entrypoint must keep deploying exactly as before.
 */
export async function detectFramework(dir: string): Promise<DetectionResult> {
  const hasIndex = await exists(join(dir, "index.ts"))
  const hasEveInstructions = await exists(join(dir, "agent", "instructions.md"))
  if (hasIndex) {
    return { framework: "zavu-native", evidence: "index.ts present" }
  }
  if (hasEveInstructions) {
    return { framework: "eve", evidence: "agent/instructions.md present" }
  }
  return {
    framework: "unknown",
    evidence: "no index.ts (Zavu) and no agent/instructions.md (eve) found",
  }
}

const TOOL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

/** Read an eve project and classify every capability as compiled or warned. */
export async function analyzeEveProject(dir: string): Promise<EveAnalysis> {
  const instructionsPath = join(dir, "agent", "instructions.md")
  let instructions: string
  try {
    instructions = await readFile(instructionsPath, "utf8")
  } catch {
    throw new Error("agent/instructions.md not found — not an eve project?")
  }
  if (instructions.trim().length === 0) {
    throw new Error("agent/instructions.md is empty — the agent needs a system prompt")
  }

  const warnings: string[] = []
  const hasAgentTs = await exists(join(dir, "agent", "agent.ts"))

  // Tools: top-level .ts files in agent/tools; the filename stem is the name.
  const tools: EveToolFile[] = []
  const toolsDir = join(dir, "agent", "tools")
  if (await isDir(toolsDir)) {
    const entries = (await readdir(toolsDir)).sort()
    for (const entry of entries) {
      if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue
      const name = entry.slice(0, -3)
      const file = "agent/tools/" + entry
      if (!TOOL_NAME_RE.test(name)) {
        warnings.push(
          "tool file " + file + " skipped: '" + name + "' is not a valid tool name"
        )
        continue
      }
      // A file is only a tool if it default-exports defineTool(...) — the same
      // condition the compat layer applies when registering. Counting files
      // instead made the report promise tools that were never created.
      let shape: EveToolExportShape = "indirect"
      try {
        shape = classifyEveToolExport(await readFile(join(toolsDir, entry), "utf8"))
      } catch {
        // Unreadable: leave it to the runtime rather than drop it here.
      }
      const toolWarning = eveToolFileWarning(file, shape)
      if (toolWarning) {
        warnings.push(toolWarning)
        continue
      }
      tools.push({ name, file })
    }
  }

  // Skills exist in the layout but are not loaded at runtime on Zavu.
  const skills: string[] = []
  const skillsDir = join(dir, "agent", "skills")
  if (await isDir(skillsDir)) {
    for (const entry of (await readdir(skillsDir)).sort()) {
      skills.push("agent/skills/" + entry)
    }
    if (skills.length > 0) {
      warnings.push(
        "agent/skills (" +
          skills.length +
          " entr" + (skills.length === 1 ? "y" : "ies") +
          ") are not loaded at runtime on Zavu — fold critical content into instructions.md or a knowledge base"
      )
    }
  }

  for (const { dir: sub, hint } of EVE_UNSUPPORTED_DIRS) {
    if (await isDir(join(dir, sub))) {
      warnings.push(sub + "/ will NOT run on Zavu — " + hint)
    }
  }

  let declaredAgentName: string | undefined
  if (hasAgentTs) {
    try {
      const agentTs = await readFile(join(dir, "agent", "agent.ts"), "utf8")
      const entries = extractEveAgentConfigEntries(agentTs)
      declaredAgentName = eveDeclaredAgentName(entries)
      warnings.push(...eveAgentConfigWarnings(entries, "will"))
    } catch {
      // Static scan only; runtime still warns.
    }
  }

  return { instructions, hasAgentTs, tools, skills, declaredAgentName, warnings }
}

/**
 * Generate the entry module that registers the eve project against Zavu's
 * runtime. Written to `.zavu/eve-entry.ts`; imports resolve relative to that
 * location, so user files sit one level up.
 */
export function generateEveEntry(
  analysis: EveAnalysis,
  opts: { agentName: string; senderId?: string }
): string {
  const lines: string[] = []
  lines.push("// Generated by zavudev — do not edit. Recreated on every deploy.")
  lines.push(
    'import { __registerEveAgent, __registerEveTool } from "./' +
      EVE_COMPAT_FILENAME.replace(/\.ts$/, "") +
      '"'
  )
  if (analysis.hasAgentTs) {
    lines.push('import __agentConfig from "../agent/agent"')
  } else {
    lines.push("const __agentConfig = undefined")
  }
  analysis.tools.forEach((tool, i) => {
    lines.push('import __tool_' + i + ' from "../' + tool.file.replace(/\.ts$/, "") + '"')
  })
  lines.push("")
  // JSON.stringify gives airtight escaping for arbitrary markdown — backticks,
  // ${, quotes, newlines all survive.
  lines.push("const __instructions = " + JSON.stringify(analysis.instructions))
  const senderExpr = opts.senderId
    ? JSON.stringify(opts.senderId)
    : "process.env.SENDER_ID"
  lines.push("__registerEveAgent(__agentConfig, {")
  lines.push("  name: " + JSON.stringify(opts.agentName) + ",")
  lines.push("  prompt: __instructions,")
  lines.push("  senderId: " + senderExpr + ",")
  lines.push("})")
  analysis.tools.forEach((tool, i) => {
    lines.push("__registerEveTool(" + JSON.stringify(tool.name) + ", __tool_" + i + ")")
  })
  lines.push("")
  return lines.join("\n")
}

/** Specifiers of the eve package that the compat module stands in for. */
export const EVE_ALIAS_RE = /^eve(\/.*)?$/

async function loadEsbuild(projectDir: string): Promise<any> {
  const candidates: string[] = []
  try {
    candidates.push(createRequire(join(projectDir, "package.json")).resolve("esbuild"))
  } catch {
    // Not installed in the project.
  }
  try {
    candidates.push(createRequire(import.meta.url).resolve("esbuild"))
  } catch {
    // Not available next to the CLI either.
  }
  for (const path of candidates) {
    try {
      const mod = await import(pathToFileURL(path).href)
      return (mod as { default?: unknown }).default ?? mod
    } catch {
      continue
    }
  }
  throw new Error(
    "esbuild is required to compile an eve project and was not found. Run `npm install -D esbuild` in the project and retry."
  )
}

export interface EveCompileResult {
  sourceCode: string
  analysis: EveAnalysis
  /** Project dependencies minus the eve package (aliased away at compile time). */
  dependencies: Record<string, string>
  agentName: string
}

/** Fall back to something sane when package.json has no usable name. */
export function deriveAgentName(dir: string, pkgName?: string): string {
  const raw = (pkgName || basename(dir)).trim()
  const cleaned = raw.replace(/^@[^/]+\//, "").replace(/[^a-zA-Z0-9 _.-]/g, "-").slice(0, 100)
  return cleaned || "eve-agent"
}

/**
 * Compile an eve-layout project into a single deployable sourceCode string.
 *
 * Bundling strategy: every bare package import is left external — the Build
 * Worker installs the project's dependencies and re-bundles server-side, so
 * the client pass only flattens local files. The `eve` package is the one
 * exception: a plugin resolves every `eve` / `eve/*` import to the generated
 * compat module, which is why the project's own source needs no edits.
 */
export async function compileEveProject(
  dir: string,
  opts: { senderId?: string } = {}
): Promise<EveCompileResult> {
  const analysis = await analyzeEveProject(dir)

  let pkg: { name?: string; dependencies?: Record<string, string> } = {}
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
  } catch {
    // A package.json is not strictly required to compile.
  }
  // The entry carries the package-derived name as the FALLBACK; the compat
  // layer prefers a `name` declared in agent.ts. Mirror that precedence here so
  // the returned name is the one the agent will actually carry.
  const fallbackName = deriveAgentName(dir, pkg.name)
  const agentName = analysis.declaredAgentName ?? fallbackName

  const zavuDir = join(dir, ".zavu")
  await mkdir(zavuDir, { recursive: true })
  const compatPath = join(zavuDir, EVE_COMPAT_FILENAME)
  const entryPath = join(zavuDir, "eve-entry.ts")
  await writeFile(compatPath, EVE_COMPAT_SOURCE, "utf8")
  await writeFile(
    entryPath,
    generateEveEntry(analysis, { agentName: fallbackName, senderId: opts.senderId }),
    "utf8"
  )

  const esbuild = await loadEsbuild(dir)
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    packages: "external",
    logLevel: "silent",
    plugins: [
      {
        name: "zavu-eve-alias",
        setup(build: any) {
          build.onResolve({ filter: EVE_ALIAS_RE }, () => ({ path: compatPath }))
        },
      },
    ],
  })
  const out = result.outputFiles?.[0]?.text
  if (!out) {
    throw new Error("esbuild produced no output while compiling the eve project")
  }

  // The eve package itself never ships: its imports were aliased into the
  // bundle. Leaving it in dependencies would make the Build Worker install a
  // framework the function no longer references.
  const dependencies: Record<string, string> = {}
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (name === "eve") continue
    dependencies[name] = version
  }

  return { sourceCode: out, analysis, dependencies, agentName }
}

/**
 * The compatibility report, printed BEFORE a deploy starts. Every eve
 * capability that will not run on Zavu is listed here — a capability silently
 * dropped would make "compatible" a lie by omission.
 */
export function printEveReport(analysis: EveAnalysis, opts: { sender?: string }): void {
  ui.info("Compiling from eve layout:")
  ui.hint(`  agent/instructions.md → system prompt (${analysis.instructions.length} chars)`)
  ui.hint(
    analysis.hasAgentTs
      ? "  agent/agent.ts → model config"
      : "  no agent/agent.ts — using the default model"
  )
  ui.hint(
    analysis.declaredAgentName
      ? `  agent/agent.ts (name) → agent name: ${JSON.stringify(analysis.declaredAgentName)}`
      : "  agent name comes from package.json — declare `name` in agent/agent.ts to choose it"
  )
  if (analysis.tools.length > 0) {
    ui.hint(`  ${analysis.tools.length} tool(s): ${analysis.tools.map((t) => t.name).join(", ")}`)
  } else {
    ui.hint("  no tools found under agent/tools/")
  }
  for (const w of analysis.warnings) {
    ui.warn(w)
  }
  if (analysis.tools.length > 0) {
    ui.hint(
      "  tools run on every channel (text, voice, flow tool steps), up to 5 tool rounds per reply"
    )
  }
  if (!opts.sender) {
    ui.hint(
      `No --sender given: the agent binds to the SENDER_ID secret at runtime. Set it with \`${cli(
        "fn secrets set SENDER_ID <id>"
      )}\` or connect a sender from the dashboard.`
    )
  }
}
