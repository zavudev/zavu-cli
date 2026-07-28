// `npx zavudev functions deploy` — read the local index.ts + package.json, push them
// to Zavu's deploy pipeline, stream status until active.
//
// The actual bundling (esbuild + npm install) happens server-side in the
// Build Worker Lambda — the CLI just sends source + declared deps. This
// keeps the CLI's compiled binary tiny (no esbuild bundled) and means
// deploys are reproducible regardless of the dev's local environment.

import { Command } from "commander"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { buildClient } from "../../lib/client"
import { buildApi } from "../../lib/api"
import { readProjectConfig } from "../../lib/config"
import { ui, fail, extractServerError } from "../../lib/ui"

export function functionsDeployCommand(): Command {
  return new Command("deploy")
    .description("Deploy the function in the current directory.")
    .option("--source <file>", "Source file relative to cwd", "index.ts")
    .option(
      "--update-runtime",
      "Bump this function to the latest runtime layer. Default: keep pinned to the runtime it last deployed against."
    )
    .option(
      "--arch <arch>",
      "CPU architecture: arm64 (default, cheapest) or x86_64 (+25% cost, broader native-module compat)."
    )
    .option("--watch", "(future) keep running and redeploy on file changes")
    .action(async (opts: { source: string; watch?: boolean; updateRuntime?: boolean; arch?: string }) => {
      if (opts.watch) {
        fail("--watch is not implemented yet. Use `npx zavudev functions invoke` for local iteration.")
      }
      const config = await readProjectConfig()
      if (!config) {
        fail("No .zavu/config.json found. Run `npx zavudev functions init` first or `cd` into a function directory.")
      }
      const client = await buildClient()

      let sourceCode: string
      try {
        sourceCode = await readFile(join(process.cwd(), opts.source), "utf8")
      } catch {
        fail(`Could not read ${opts.source}. Pass --source <file> if your entrypoint is named differently.`)
      }

      // Read declared dependencies + the optional `zavu` config block from
      // package.json. The server's Build Worker installs the deps; the `zavu`
      // block lets users pin architecture etc. directly in source control.
      let dependencies: Record<string, string> = {}
      let pkgArch: string | undefined
      try {
        const pkgRaw = await readFile(join(process.cwd(), "package.json"), "utf8")
        const pkg = JSON.parse(pkgRaw) as {
          dependencies?: Record<string, string>
          zavu?: { architecture?: string }
        }
        dependencies = pkg.dependencies ?? {}
        pkgArch = pkg.zavu?.architecture
      } catch {
        // No package.json — fine for templates with zero deps.
      }

      // Architecture precedence: CLI flag > package.json > server default (arm64).
      // Validate so we surface bad input before the deploy round-trip.
      const archInput = opts.arch ?? pkgArch
      let architecture: "arm64" | "x86_64" | undefined
      if (archInput !== undefined) {
        if (archInput !== "arm64" && archInput !== "x86_64") {
          fail(`Invalid --arch "${archInput}". Use "arm64" (default) or "x86_64".`)
        }
        architecture = archInput
      }

      ui.step(`Deploying ${config!.name} (${config!.slug})…`)
      const startedAt = Date.now()

      const res = await fetch(
        `${client.baseURL}/v1/functions/${config!.functionId}/deploy`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${client.apiKey}`,
          },
          body: JSON.stringify({
            sourceCode,
            dependencies,
            ...(architecture ? { architecture } : {}),
            ...(opts.updateRuntime ? { updateRuntime: true } : {}),
          }),
        }
      )
      if (!res.ok) {
        fail(await extractServerError(res, `Deploy request rejected (${res.status})`))
      }
      const created = (await res.json()) as { deployment?: { id: string } }
      const deploymentId = created.deployment?.id
      if (!deploymentId) {
        fail("Server did not return a deployment id.")
      }
      ui.hint(`deployment id: ${deploymentId}`)

      // Poll deployment status until terminal. The server's deploy action
      // updates `status` through bundling → uploading → publishing → active|failed.
      let lastStatus = ""
      while (true) {
        await sleep(1500)
        const detailRes = await fetch(
          `${client.baseURL}/v1/functions/deployments/${deploymentId}`,
          { headers: { Authorization: `Bearer ${client.apiKey}` } }
        )
        if (!detailRes.ok) {
          ui.warn(`Status poll failed (${detailRes.status}); will retry…`)
          continue
        }
        const detailJson = (await detailRes.json()) as {
          deployment?: {
            status: string
            errorMessage?: string | null
            reconcileSummary?: ReconcileSummary | null
            reconcileWarning?: string | null
          }
        }
        const d = detailJson.deployment
        if (!d) {
          ui.warn("Status poll returned no deployment; will retry…")
          continue
        }
        if (d.status !== lastStatus) {
          ui.step(`status: ${d.status}`)
          lastStatus = d.status
        }
        if (d.status === "active") {
          // The summary goes BEFORE the success line. Under a green ✓ nobody
          // reads it, and the things it reports — tools that will never fire,
          // a second agent shadowing the first, a manifest probe that threw —
          // are precisely the ones that make a "successful" deploy a lie.
          printReconcileSummary(d.reconcileSummary, d.reconcileWarning)
          const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
          // A green ✓ between the error above and the warning below read as a
          // clean deploy that happened to print something. The tick is only
          // earned when everything in the source actually synced.
          if (d.reconcileWarning) {
            ui.warn(`Deployed with errors in ${elapsed}.`)
          } else {
            await ui.scrambleSuccess(`Deployed in ${elapsed}`)
          }
          // The URL lives on the server, not in .zavu/config.json — which is
          // written at scaffold time and never carries it. Reading the local
          // file meant this line could not fire, so `--http` produced an
          // endpoint with no way to discover its address.
          try {
            const api = await buildApi()
            const fn = await api.get<{
              function?: { httpEnabled?: boolean; publicUrl?: string | null }
            }>(`/v1/functions/${config!.functionId}`)
            if (fn.function?.httpEnabled && fn.function.publicUrl) {
              ui.info(`Public URL: ${fn.function.publicUrl}`)
            }
          } catch {
            // Never fail a successful deploy over a cosmetic lookup.
          }
          // The Lambda is live either way, so this is not `fail()`. But a
          // probe that threw means the agents and tools in the source were
          // never synced, and a script that only checks the exit code must not
          // read that as success.
          if (d.reconcileWarning) {
            ui.warn(
              "The declarations in your source were NOT synced. The function is live, but its agents and tools are unchanged. Fix the error above and deploy again."
            )
            process.exitCode = 1
          }
          return
        }
        if (d.status === "failed") {
          fail(d.errorMessage ?? "Deploy failed.")
        }
      }
    })
}

// Shape of `deployment.reconcileSummary` from the backend. Populated when the
// user's source code calls `defineAgent` / `defineTool` — undefined / null
// when there's nothing to sync (then we render nothing).
interface ReconcileSummary {
  agentsCreated: string[]
  agentsUpdated: string[]
  /** Present since the reconcile learned to diff. Older servers omit it. */
  agentsUnchanged?: string[]
  agentsDeleted: string[]
  toolsCreated: string[]
  toolsUpdated: string[]
  toolsUnchanged?: string[]
  toolsDeleted: string[]
  warnings: string[]
}

function printReconcileSummary(
  summary: ReconcileSummary | null | undefined,
  warning: string | null | undefined
): void {
  if (!summary && !warning) return
  if (summary) {
    const agentsTouched =
      summary.agentsCreated.length +
      summary.agentsUpdated.length +
      (summary.agentsUnchanged?.length ?? 0) +
      summary.agentsDeleted.length
    const toolsTouched =
      summary.toolsCreated.length +
      summary.toolsUpdated.length +
      (summary.toolsUnchanged?.length ?? 0) +
      summary.toolsDeleted.length
    // `=` for unchanged. Previously everything that already existed printed as
    // `~`, so a redeploy with no source change was indistinguishable from one
    // that rewrote the prompt — and the only way to confirm an edit had landed
    // was to run `agents test` with a sentinel word in it.
    if (agentsTouched > 0) {
      ui.info("Agents synced:")
      for (const n of summary.agentsCreated) ui.hint(`  + ${n}`)
      for (const n of summary.agentsUpdated) ui.hint(`  ~ ${n}`)
      for (const n of summary.agentsUnchanged ?? []) ui.hint(`  = ${n} (unchanged)`)
      for (const n of summary.agentsDeleted) ui.hint(`  - ${n}`)
    }
    if (toolsTouched > 0) {
      ui.info("Tools synced:")
      for (const n of summary.toolsCreated) ui.hint(`  + ${n}`)
      for (const n of summary.toolsUpdated) ui.hint(`  ~ ${n}`)
      for (const n of summary.toolsUnchanged ?? []) ui.hint(`  = ${n} (unchanged)`)
      for (const n of summary.toolsDeleted) ui.hint(`  - ${n}`)
    }
    for (const w of summary.warnings) ui.warn(w)
  }
  if (warning) ui.warn(`manifest probe: ${warning}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
