// `npx zavudev functions invoke` — run the local function with a synthetic event,
// no AWS deploy needed.
//
// This is the inner-loop iteration command. The dev edits index.ts, runs
// `npx zavudev functions invoke --event message.inbound`, sees output in <500ms,
// repeats. Skips bundling, npm install, Lambda upload — straight tsx execution.
//
// Two run modes:
//   --mock   — replaces zavu.messages.send / zavu.contacts.* with stubs that
//              just log. Default. Safe for local iteration.
//   --live   — uses the real SDK with the user's API key. Sends actual
//              messages. Use with care.

import { Command } from "commander"
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { readProjectConfig, resolveCredentials } from "../../lib/config"
import { buildApi } from "../../lib/api"
import { detectFramework, compileEveProject } from "../../lib/frameworks"
import { ui, fail } from "../../lib/ui"

interface InvokeOpts {
  event: string
  data?: string
  dataFile?: string
  source: string
  live?: boolean
  // Tool-dispatch mode: instead of calling the function's default handler with
  // an event, look up a tool by name in the registry that `defineTool` populated
  // at module load and call its handler directly. Mirrors what the wrapper does
  // in production when the agent calls a tool.
  tool?: string
  args?: string
  argsFile?: string
}

export function functionsInvokeCommand(): Command {
  return new Command("invoke")
    .description("Run the function locally with a synthetic event OR call a defineTool by name.")
    .option("--event <name>", "Event type (e.g. message.inbound)", "message.inbound")
    .option("--data <json>", "Inline JSON for event.data")
    .option("--data-file <path>", "Path to a JSON file for event.data")
    .option("--source <file>", "Source file", "index.ts")
    .option("--live", "Make real API calls (default: stubbed/mock mode)")
    .option("--tool <name>", "Call a defineTool by name instead of dispatching an event")
    .option("--args <json>", "Inline JSON for the tool's arguments")
    .option("--args-file <path>", "Path to a JSON file for the tool's arguments")
    .action(async (opts: InvokeOpts) => {
      const config = await readProjectConfig()
      // Resolved, so `--live` uses the credentials the rest of the CLI is
      // using. Reading the file meant an env-var session ran "live" against
      // whatever key happened to be stored, or none at all.
      const creds = await resolveCredentials()

      // ── Tool-dispatch mode ────────────────────────────────────────────────
      // When --tool is passed, we ignore event/data and instead call a
      // defineTool handler by name. The runner imports the user's source
      // (which populates globalThis.__ZAVU_REGISTRY at module load via
      // defineTool side effects), looks up the tool, and calls its handler.
      const toolMode = Boolean(opts.tool)

      let toolArgs: Record<string, unknown> = {}
      if (toolMode) {
        if (opts.argsFile) {
          try {
            toolArgs = JSON.parse(await readFile(opts.argsFile, "utf8"))
          } catch (err) {
            fail(`Could not parse --args-file: ${err instanceof Error ? err.message : err}`)
          }
        } else if (opts.args) {
          try {
            toolArgs = JSON.parse(opts.args)
          } catch (err) {
            fail(`Invalid --args JSON: ${err instanceof Error ? err.message : err}`)
          }
        }
      }

      let data: unknown = { from: "+15555550100", text: "hello", channel: "whatsapp" }
      if (opts.dataFile) {
        try {
          data = JSON.parse(await readFile(opts.dataFile, "utf8"))
        } catch (err) {
          fail(`Could not parse --data-file: ${err instanceof Error ? err.message : err}`)
        }
      } else if (opts.data) {
        try {
          data = JSON.parse(opts.data)
        } catch (err) {
          fail(`Invalid --data JSON: ${err instanceof Error ? err.message : err}`)
        }
      }

      const event = {
        id: `evt_local_${Date.now()}`,
        type: opts.event,
        timestamp: Date.now(),
        senderId: config?.functionId ?? "sender_local",
        projectId: config?.projectId ?? "project_local",
        data,
      }

      // Build a temporary runner script that imports the user's source and
      // invokes its default export with our synthetic event. We monkey-patch
      // the global `fetch` for --mock mode so SDK calls become no-ops.
      // The runner MUST live inside the user's project, not in tmpdir(). Bun
      // resolves imports (and reads tsconfig `paths`) relative to the
      // entrypoint, so a runner in /tmp cannot see the project's tsconfig —
      // and `@zavudev/functions` then fails to resolve. That failure surfaced as the
      // module never loading, which in turn made the registry look empty and
      // printed the thoroughly misleading "available tools: (none)".
      // An eve project has no index.ts, so the default source would send the
      // runner looking for a file that cannot exist — and `agents test` and the
      // published skill both tell you to run exactly this command to exercise
      // an eve tool. Compiling first gives the runner the same generated entry
      // the deploy path uses, so a tool behaves here the way it will in
      // production. An explicit --source is always honoured verbatim.
      let effectiveSource = opts.source
      let isEve = false
      if (opts.source === "index.ts") {
        const detection = await detectFramework(process.cwd())
        if (detection.framework === "eve") {
          ui.step(`eve project detected (${detection.evidence}) — compiling…`)
          let compiled
          try {
            compiled = await compileEveProject(process.cwd())
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
          // Run the bundle, not the generated entry. The bundle is what deploy
          // ships, and it has `eve` already resolved to the compat layer — the
          // entry still imports `eve` by name, which an eve project does have
          // but only as a build-time dependency we compile away. Running the
          // same artifact is also the only way a local result is evidence
          // about production.
          effectiveSource = join(".zavu", "eve-invoke.ts")
          await writeFile(join(process.cwd(), effectiveSource), compiled!.sourceCode, "utf8")
          isEve = true
        }
      }

      // The generated entry already lives in `.zavu/`, so deriving the project
      // root from its dirname would nest the runner one level deeper and put it
      // somewhere the project's tsconfig no longer applies.
      const projectDir = isEve ? process.cwd() : dirname(resolve(process.cwd(), effectiveSource))
      const runnerDir = join(projectDir, ".zavu")
      await mkdir(runnerDir, { recursive: true })
      const runnerPath = join(runnerDir, `invoke-${randomBytes(4).toString("hex")}.ts`)

      // The runner imports the user's source as a SIDE EFFECT (defineAgent /
      // defineTool register themselves at module load by pushing into
      // globalThis.__ZAVU_REGISTRY). In tool mode we then read the registry
      // and call the named tool's handler. In event mode we call the
      // module's default export (if any).
      const sourcePath = join(process.cwd(), effectiveSource).replace(/\\/g, "/")
      const runnerSource = `
// Import the user module — defineAgent / defineTool fire here.
import * as userModule from "${sourcePath}"
// Keep the import alive. TypeScript elides an unreferenced namespace import,
// and in --tool mode nothing else touches \`userModule\` — so the user's file
// was never executed, defineTool never registered, and the run failed with the
// thoroughly misleading "available tools: (none)".
void userModule

${opts.live ? "" : `
// --- mock mode: stub outgoing HTTP so messages don't actually send ---
const _origFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url
  if (url.includes("api.zavu.dev") || url.includes("/v1/messages") || url.includes(".convex.site")) {
    console.log("[mock] " + (init?.method ?? "GET") + " " + url)
    if (init?.body) console.log("[mock] body:", init.body.toString().slice(0, 200))
    return new Response(JSON.stringify({ ok: true, mocked: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return _origFetch(input as any, init)
}) as typeof fetch
`}

// ctx.memory. The deployed runtime puts it on every context, so a handler that
// reads ctx.memory has to find one here too — otherwise the same code that
// works in production dies locally on an undefined, which reads as "the SDK is
// broken". Without --live the runtime keeps it in memory for the length of this
// process and says so.
//
// Feature-detected, and the older internal name is tried second: a project
// still on @zavudev/functions 0.2.x has neither, and a missing ctx.memory is
// better than a crashed runner.
let _ctxExtras: Record<string, any> = {}
try {
  const _runtime: any = await import("@zavudev/functions")
  const _build = _runtime.createLocalContext ?? _runtime.__buildCtxExtras
  if (typeof _build === "function") {
    _ctxExtras = _build({})
  }
} catch {
  // No runtime resolvable from here; the user's own import would have failed first.
}

const ctx = {
  awsRequestId: "local-" + Date.now(),
  getRemainingTimeInMillis: () => 30000,
  projectId: ${JSON.stringify(config?.projectId ?? "project_local")},
  functionId: ${JSON.stringify(config?.functionId ?? "fn_local")},
  slug: ${JSON.stringify(config?.slug ?? "local")},
  log: (...args: any[]) => console.log("[ctx.log]", ...args),
  ..._ctxExtras,
}

${toolMode ? `
// ── Tool mode ──────────────────────────────────────────────────────────
const toolName = ${JSON.stringify(opts.tool)}
const toolArgs = ${JSON.stringify(toolArgs)}
const registry = (globalThis as any).__ZAVU_REGISTRY ?? { agents: [], tools: [] }
const tool = registry.tools.find((t: any) => t.name === toolName)
if (!tool) {
  console.error("✗ tool not found:", toolName)
  console.error("  available tools:", registry.tools.map((t: any) => t.name).join(", ") || "(none)")
  process.exit(2)
}
// Validate against the schema the tool itself declares, before calling it.
//
// Without this, \`fn invoke --tool qualify_lead --args '{}'\` ran the handler
// with every field undefined and printed a green \`ok: true\` full of the string
// "undefined". The whole point of this command is to verify a handler works, so
// a pass that only proves "it did not throw" is worse than no check at all —
// especially for an agent that treats exit 0 as confirmation.
//
// The model is given the same JSON Schema at runtime and will not call a tool
// with a required field missing, so failing here matches production rather than
// being stricter than it.
const schema = tool.parameters
if (schema && typeof schema === "object") {
  const props = (schema.properties ?? {}) as Record<
    string,
    { type?: string; enum?: unknown[] }
  >
  const required = (schema.required ?? []) as string[]
  const problems: string[] = []

  for (const key of required) {
    if (toolArgs[key] === undefined) problems.push(\`missing required "\${key}"\`)
  }
  for (const [key, value] of Object.entries(toolArgs)) {
    if (!props[key]) {
      problems.push(\`unknown argument "\${key}"\`)
      continue
    }
    const want = props[key].type
    if (value === null) continue
    if (want) {
      const got = Array.isArray(value) ? "array" : typeof value
      // JSON Schema's "integer" has no JS typeof; treat it as a number check.
      const ok = want === "integer" ? Number.isInteger(value) : got === want
      if (!ok) {
        problems.push(\`"\${key}" should be \${want}, got \${got}\`)
        continue
      }
    }
    // A closed enum is the strictest thing the schema says, and it is the one a
    // caller is most likely to get wrong — the value has the right type, so a
    // type check waves it through and the handler switches on a case that never
    // matches. The model is handed this same list, so a value outside it is not
    // something production would ever send.
    const allowed = props[key].enum
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(value)) {
      problems.push(
        \`"\${key}" must be one of \${allowed.map((v) => JSON.stringify(v)).join(" | ")}, got \${JSON.stringify(value)}\`
      )
    }
  }

  if (problems.length > 0) {
    console.error("✗ arguments do not match the tool's schema:")
    for (const p of problems) console.error("   • " + p)
    const shape = Object.entries(props)
      .map(([k, v]) => {
        // Show the enum instead of the bare type: "cold|warm|hot" tells the
        // caller how to fix it, "string" only tells them they already were.
        const t = Array.isArray(v.enum) && v.enum.length > 0
          ? v.enum.map((x) => String(x)).join("|")
          : v.type ?? "any"
        return \`\${k}: \${t}\${required.includes(k) ? "" : "?"}\`
      })
      .join(", ")
    console.error("  expected: { " + shape + " }")
    process.exit(2)
  }
}

console.log("→ invoking tool:", toolName)
console.log("  args:", JSON.stringify(toolArgs))
const start = Date.now()
try {
  const result = await tool.handler(toolArgs, ctx)
  console.log("← result:", JSON.stringify(result, null, 2))
  console.log("  duration:", (Date.now() - start) + "ms")
} catch (err) {
  console.error("✗ tool handler threw:", err)
  process.exit(1)
}
` : `
// ── Event mode ─────────────────────────────────────────────────────────
const event = ${JSON.stringify(event, null, 2)}
const handler = (userModule as any).default ?? (userModule as any).handler
if (typeof handler !== "function") {
  console.error("✗ no default export found in ${opts.source}.")
  console.error("  Add 'export default defineFunction(async (event, ctx) => { ... })'")
  console.error("  to handle events, or use --tool <name> to call a defineTool directly.")
  process.exit(2)
}
console.log("→ invoking with event.type =", event.type)
const start = Date.now()
try {
  const result = await handler(event as any, ctx as any)
  console.log("← result:", JSON.stringify(result, null, 2))
  console.log("  duration:", (Date.now() - start) + "ms")
} catch (err) {
  console.error("✗ handler threw:", err)
  process.exit(1)
}
`}
`
      await writeFile(runnerPath, runnerSource, "utf8")

      // Secrets: load a local .env, then say out loud what is still missing.
      //
      // The deployed function gets its secrets injected by the runtime. `fn
      // invoke` cannot do the same — the API returns each secret's key and last
      // four characters, never the value, which is the right call for a secret
      // store. So a handler that reads process.env.CALCOM_API_KEY locally hit
      // its own failure branch and returned something like
      // `{ ok: false, reason: "not_configured" }` — a plausible, quiet, wrong
      // answer that reads as "my code is broken".
      //
      // `--live` made that worse by promising real calls while still running
      // without credentials.
      const dotenv = await loadDotEnv(projectDir)
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        ...dotenv,
        ZAVU_FUNCTION_ID: config?.functionId ?? "fn_local",
        ZAVU_PROJECT_ID: config?.projectId ?? "project_local",
        ZAVU_FUNCTION_SLUG: config?.slug ?? "local",
        ZAVU_API_KEY: opts.live && creds?.apiKey ? creds.apiKey : "stub",
        ZAVU_API_BASE_URL: creds?.apiBaseUrl ?? "https://api.zavu.dev",
      }

      // The runner imports the user's source, which imports @zavudev/functions.
      // If deps were never installed, Bun fails with a raw
      // "Cannot find module '@zavudev/functions'" on its own stderr — which we
      // cannot rewrite, since the child inherits stdio. So check first and say
      // the one thing that actually fixes it.
      try {
        await stat(join(projectDir, "node_modules", "@zavudev", "functions"))
      } catch {
        // An eve project never declares @zavudev/functions — the compat layer
        // the compile step generates is what pulls it in. So `npm install`
        // alone can never satisfy this, and saying so sends the user in a
        // circle they have usually already run.
        if (isEve) {
          ui.warn("Running an eve tool locally needs the Zavu runtime package.")
          ui.hint(`Run \`npm install @zavudev/functions\` in ${projectDir}, then try again.`)
          ui.hint("(Only local invoke needs it. Deploying installs it for you.)")
        } else {
          ui.warn("Dependencies are not installed in this project.")
          ui.hint(`Run \`npm install\` in ${projectDir}, then try again.`)
          ui.hint("(Deploy does not need it; local invoke and tsc do.)")
        }
        process.exit(2)
      }

      // Name the gap instead of letting the handler fail its own way.
      if (config?.functionId) {
        try {
          const api = await buildApi()
          const res = await api.get<{ secrets?: Array<{ key: string }> }>(
            `/v1/functions/${config.functionId}/secrets`
          )
          const missing = (res.secrets ?? [])
            .map((s) => s.key)
            .filter((k) => k !== "ZAVU_API_KEY" && env[k] === undefined)
          if (missing.length > 0) {
            ui.warn(
              `Not injected locally: ${missing.join(", ")} — the API never returns secret values.`
            )
            ui.hint(`Put them in ${join(projectDir, ".env")} or export them before running.`)
            ui.hint("Handlers that read them will take their unconfigured branch.")
          }
        } catch {
          // A lookup failure must not block a local run.
        }
      }

      const label = toolMode
        ? `tool:${opts.tool}`
        : `event:${opts.event}`
      ui.step(`Invoking ${config?.slug ?? "local"} → ${label} (${opts.live ? "LIVE" : "mock"})`)
      let exitCode = 0
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn("bun", ["run", runnerPath], {
            stdio: "inherit",
            env,
          })
          child.on("error", (err: NodeJS.ErrnoException) => {
            // The local runner executes the function's TypeScript directly, which
            // needs Bun. Every other command runs fine under plain Node (`npx
            // zavu …`); only local invoke depends on it.
            if (err.code === "ENOENT") {
              reject(
                new Error(
                  "`npx zavudev functions invoke` runs your function locally with Bun. " +
                    "Install it from https://bun.sh, or deploy and test with `npx zavudev functions deploy`."
                )
              )
              return
            }
            reject(err)
          })
          // Carry the runner's own code instead of collapsing every failure to
          // 1. The runner distinguishes them — 2 means "you called it wrong"
          // (unknown tool, arguments that do not match the schema), 1 means the
          // handler itself threw — and a caller that retries on 1 but reports on
          // 2 loses that for free otherwise.
          child.on("exit", (code) => {
            if (code === 0) return resolve()
            const err = new Error(`exit ${code}`) as Error & { exitCode?: number }
            err.exitCode = code ?? 1
            reject(err)
          })
        })
      } catch (err) {
        // Rethrown after the finally below runs, so the generated runner is
        // still cleaned up on the failure path.
        exitCode = (err as { exitCode?: number }).exitCode ?? 1
        if (exitCode === 1) throw err
      } finally {
        // Only the generated runner — `.zavu/` also holds config.json and the
        // local runtime stand-in.
        await rm(runnerPath, { force: true })
      }
      if (exitCode !== 0) process.exit(exitCode)
    })
}

/**
 * Read `.env` from the function directory, if there is one.
 *
 * Deliberately minimal: `KEY=value`, `#` comments, optional surrounding quotes.
 * Anything fancier belongs in the user's own tooling — this exists so local
 * invocation can see the same names the deployed function sees, not to become a
 * dotenv implementation.
 */
async function loadDotEnv(dir: string): Promise<Record<string, string>> {
  let raw: string
  try {
    raw = await readFile(join(dir, ".env"), "utf8")
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}
