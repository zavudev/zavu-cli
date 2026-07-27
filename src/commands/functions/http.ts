// `zavu fn info` and `zavu fn http enable|disable`.
//
// Both exist because the public HTTPS endpoint was, until now, the one step in
// the Functions lifecycle that could not be done or even *observed* from a
// terminal. `--http` at creation set the flag, but nothing ever printed the URL
// — it lives on the server, and the CLI was reading a local config file that
// never carries it. So the flag produced a working endpoint at an address the
// caller had no way to learn.
//
// `http enable` applies immediately to the deployed function via the AWS tag
// sync; no redeploy is needed.

import { Command } from "commander"
import { buildApi } from "../../lib/api"
import { readProjectConfig } from "../../lib/config"
import { ui, fail, cli } from "../../lib/ui"

interface FunctionPayload {
  id: string
  slug: string
  name: string
  status?: string
  httpEnabled?: boolean
  publicUrl?: string | null
  runtime?: string
  timeoutSec?: number
  memoryMb?: number
  activeDeploymentId?: string | null
}

/** Resolve the function this directory is linked to, or fail with the fix. */
async function resolveFunctionId(explicit?: string): Promise<string> {
  if (explicit) return explicit
  const config = await readProjectConfig()
  if (!config?.functionId) {
    fail(
      `No function linked here. Run this inside a scaffolded directory, or pass the id: ${cli(
        "fn info <functionId>"
      )}`
    )
  }
  return config!.functionId
}

async function fetchFunction(functionId: string): Promise<FunctionPayload> {
  const api = await buildApi()
  const res = await api.get<{ function?: FunctionPayload }>(
    `/v1/functions/${functionId}`
  )
  if (!res.function) fail("Function not found.")
  return res.function!
}

export function functionsInfoCommand(): Command {
  return new Command("info")
    .description("Show a function's status, and its public URL when HTTP is on.")
    .argument("[functionId]", "Defaults to the function in .zavu/config.json")
    .option("--json", "Print the raw JSON response")
    .action(async (functionIdArg: string | undefined, opts: { json?: boolean }) => {
      const fn = await fetchFunction(await resolveFunctionId(functionIdArg))
      if (opts.json) {
        process.stdout.write(JSON.stringify(fn, null, 2) + "\n")
        return
      }
      ui.info(`${fn.name} (${fn.slug})`)
      ui.hint(`id:      ${fn.id}`)
      ui.hint(`status:  ${fn.status ?? "unknown"}`)
      ui.hint(`runtime: ${fn.runtime ?? "-"}  ${fn.memoryMb ?? "-"}MB  ${fn.timeoutSec ?? "-"}s`)
      if (fn.httpEnabled) {
        // Only printed when the endpoint is actually on. The server stores a URL
        // for every function, deployed or not, so printing it unconditionally
        // would advertise an address that 404s.
        ui.hint(`http:    enabled`)
        if (fn.publicUrl) ui.info(`Public URL: ${fn.publicUrl}`)
        else ui.hint("The URL appears once the function has been deployed.")
      } else {
        ui.hint(`http:    disabled  (${cli("fn http enable")} to expose it)`)
      }
    })
}

export function functionsHttpCommand(): Command {
  const cmd = new Command("http").description(
    "Expose the function on a public HTTPS URL, or take it down."
  )

  const toggle = (name: "enable" | "disable") =>
    new Command(name)
      .description(
        name === "enable"
          ? "Turn on the public HTTPS endpoint (applies immediately, no redeploy)."
          : "Turn off the public HTTPS endpoint."
      )
      .argument("[functionId]", "Defaults to the function in .zavu/config.json")
      .action(async (functionIdArg?: string) => {
        const functionId = await resolveFunctionId(functionIdArg)
        const api = await buildApi()
        try {
          await api.patch(`/v1/functions/${functionId}`, {
            httpEnabled: name === "enable",
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // This endpoint accepts httpEnabled. If the server says otherwise it
          // is running older code than the CLI, and the only useful thing to
          // report is WHICH server — the previous version of this message
          // claimed "the API does not support this yet", which sent people
          // looking for a missing feature instead of a stale deployment.
          if (/sourceCode/i.test(msg) && !/httpEnabled/i.test(msg)) {
            fail(
              `${api.baseUrl} is running an API older than this CLI: it does not know httpEnabled.\n` +
                "  Deploy the backend there, or point the CLI at one that has it (`zavu login --base-url <url>`)."
            )
          }
          fail(msg)
        }
        const fn = await fetchFunction(functionId)
        if (name === "disable") {
          ui.success(`HTTP disabled for "${fn.slug}".`)
          return
        }
        ui.success(`HTTP enabled for "${fn.slug}".`)
        if (fn.publicUrl) ui.info(`Public URL: ${fn.publicUrl}`)
        else ui.hint(`The URL appears after your first ${cli("deploy")}.`)
      })

  cmd.addCommand(toggle("enable"))
  cmd.addCommand(toggle("disable"))
  return cmd
}
