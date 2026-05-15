// `zavu functions invoke` — run the local function with a synthetic event,
// no AWS deploy needed.
//
// This is the inner-loop iteration command. The dev edits index.ts, runs
// `zavu functions invoke --event message.inbound`, sees output in <500ms,
// repeats. Skips bundling, npm install, Lambda upload — straight tsx execution.
//
// Two run modes:
//   --mock   — replaces zavu.messages.send / zavu.contacts.* with stubs that
//              just log. Default. Safe for local iteration.
//   --live   — uses the real SDK with the user's API key. Sends actual
//              messages. Use with care.

import { Command } from "commander"
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { readProjectConfig, readCredentials } from "../../lib/config"
import { ui, fail } from "../../lib/ui"

interface InvokeOpts {
  event: string
  data?: string
  dataFile?: string
  source: string
  live?: boolean
}

export function functionsInvokeCommand(): Command {
  return new Command("invoke")
    .description("Run the function locally with a synthetic event.")
    .option("--event <name>", "Event type (e.g. message.inbound)", "message.inbound")
    .option("--data <json>", "Inline JSON for event.data")
    .option("--data-file <path>", "Path to a JSON file for event.data")
    .option("--source <file>", "Source file", "index.ts")
    .option("--live", "Make real API calls (default: stubbed/mock mode)")
    .action(async (opts: InvokeOpts) => {
      const config = await readProjectConfig()
      const creds = await readCredentials()

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
      const runnerDir = join(tmpdir(), `zavu-invoke-${randomBytes(4).toString("hex")}`)
      await mkdir(runnerDir, { recursive: true })
      const runnerPath = join(runnerDir, "runner.ts")

      const runnerSource = `
import handler from "${join(process.cwd(), opts.source).replace(/\\/g, "/")}"

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

const event = ${JSON.stringify(event, null, 2)}
const ctx = {
  awsRequestId: "local-" + Date.now(),
  getRemainingTimeInMillis: () => 30000,
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
`
      await writeFile(runnerPath, runnerSource, "utf8")

      // Inject the same env vars the deployed Lambda would see.
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        ZAVU_FUNCTION_ID: config?.functionId ?? "fn_local",
        ZAVU_PROJECT_ID: config?.projectId ?? "project_local",
        ZAVU_FUNCTION_SLUG: config?.slug ?? "local",
        ZAVU_API_KEY: opts.live && creds?.apiKey ? creds.apiKey : "stub",
        ZAVU_API_BASE_URL: creds?.apiBaseUrl ?? "https://api.zavu.dev",
      }

      ui.step(`Invoking ${config?.slug ?? "local"} with ${opts.event} (${opts.live ? "LIVE" : "mock"})`)
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn("bun", ["run", runnerPath], {
            stdio: "inherit",
            env,
          })
          child.on("error", reject)
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
        })
      } finally {
        await rm(runnerDir, { recursive: true, force: true })
      }
    })
}
