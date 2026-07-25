// `zavu fn versions …` — browse deployment history and roll back.
//
// The version number is monotonic per function (1, 2, 3, …). `list` shows
// every deployment with status, who deployed it, when, and whether it's the
// current active one. `rollback` takes either a version number or a
// deploymentId and re-publishes that snapshot.
//
// Rollback always asks for confirmation — typing the version number — so
// you can't accidentally point production at last week's code.

import { Command } from "commander"
import prompts from "prompts"
import { buildClient } from "../../lib/client"
import { readProjectConfig } from "../../lib/config"
import { ui, fail, cli, extractServerError } from "../../lib/ui"

interface DeploymentRow {
  id: string
  version: number
  status: string
  runtimeLayerArn: string | null
  bundleSizeBytes: number | null
  errorMessage: string | null
  isActive: boolean
  reconcileSummary: unknown | null
  reconcileWarning: string | null
  deployedAt: string | null
  createdAt: string
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const client = await buildClient()
  const res = await fetch(`${client.baseURL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${client.apiKey}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return undefined as T
  if (!res.ok) {
    fail(await extractServerError(res, `${method} ${path} → ${res.status}`))
  }
  return (await res.json()) as T
}

async function resolveFunctionId(explicit?: string): Promise<string> {
  if (explicit) return explicit
  const config = await readProjectConfig()
  if (!config) {
    fail(
      "No --function <id> and no .zavu/config.json. Run from a function directory or pass --function."
    )
  }
  return config!.functionId
}

// Resolve the user's --to <ref> argument to a deploymentId.
// Accepts either a version number ("3", "v3") or an opaque deployment id.
async function resolveDeploymentRef(
  functionId: string,
  ref: string
): Promise<{ deploymentId: string; version: number }> {
  const versionMatch = ref.match(/^v?(\d+)$/)
  const list = await api<{ deployments: DeploymentRow[] }>(
    "GET",
    `/v1/functions/${functionId}/deployments?limit=200`
  )
  if (versionMatch) {
    const wantedVersion = Number(versionMatch[1])
    const hit = list.deployments.find((d) => d.version === wantedVersion)
    if (!hit) fail(`No deployment v${wantedVersion} on this function.`)
    return { deploymentId: hit!.id, version: hit!.version }
  }
  const hit = list.deployments.find((d) => d.id === ref)
  if (!hit) fail(`Deployment ${ref} not found on this function.`)
  return { deploymentId: hit!.id, version: hit!.version }
}

export function functionsVersionsCommand(): Command {
  const cmd = new Command("versions")
    .alias("history")
    .description("Browse deployment history and roll back to any version.")

  cmd
    .command("list")
    .description("Show the deployment history of the function.")
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .option("--limit <n>", "How many deployments to show", "20")
    .option("--json", "Print as JSON")
    .action(
      async (opts: { function?: string; limit: string; json?: boolean }) => {
        const functionId = await resolveFunctionId(opts.function)
        const res = await api<{ deployments: DeploymentRow[] }>(
          "GET",
          `/v1/functions/${functionId}/deployments?limit=${opts.limit}`
        )
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.deployments, null, 2) + "\n")
          return
        }
        if (res.deployments.length === 0) {
          ui.info("No deployments yet.")
          return
        }
        ui.table(
          res.deployments.map((d) => ({
            version: `v${d.version}${d.isActive ? " (active)" : ""}`,
            status: d.status,
            runtime: d.runtimeLayerArn
              ? d.runtimeLayerArn.split(":").slice(-1)[0]
              : "—",
            size: d.bundleSizeBytes
              ? `${Math.round(d.bundleSizeBytes / 1024)}KB`
              : "—",
            deployed: d.deployedAt
              ? new Date(d.deployedAt).toLocaleString()
              : "—",
          }))
        )
        ui.hint(`Roll back with: ${cli("fn rollback v<N>")}`)
      }
    )

  return cmd
}

export function functionsRollbackCommand(): Command {
  return new Command("rollback")
    .description(
      "Roll back to a previous deployment. Always asks for confirmation."
    )
    .argument(
      "<version>",
      "Version number (e.g. 'v3' or '3') or deployment id."
    )
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .option(
      "-y, --yes",
      "Skip the confirmation prompt (useful for CI). Be careful."
    )
    .action(
      async (
        ref: string,
        opts: { function?: string; yes?: boolean }
      ) => {
        const functionId = await resolveFunctionId(opts.function)
        const target = await resolveDeploymentRef(functionId, ref)

        ui.warn(`About to roll back this function to v${target.version}.`)
        ui.hint("This will:")
        ui.hint("  • Replace your current draft with the v" + target.version + " source.")
        ui.hint("  • Restore that version's dependencies and runtime layer.")
        ui.hint("  • Trigger a new deploy (creates a new deployment row).")
        ui.hint("  • NOT touch your secrets — those stay as-is.")

        if (!opts.yes) {
          const res = await prompts({
            type: "text",
            name: "confirm",
            message: `Type "${target.version}" to confirm rollback to v${target.version}:`,
          })
          if (!res.confirm) {
            ui.info("Cancelled.")
            return
          }
          if (String(res.confirm) !== String(target.version)) {
            fail(
              `Confirmation didn't match. Expected "${target.version}", got "${res.confirm}".`
            )
          }
        }

        ui.step("Rolling back…")
        const startedAt = Date.now()
        const result = await api<{
          deployment: { id: string; status: string }
          rolledBackToVersion: number
          previousDraft: string | null
        }>("POST", `/v1/functions/${functionId}/rollback`, {
          deploymentId: target.deploymentId,
        })

        // Poll until the new deployment is active. The deployment id is the
        // NEW row, not the historical one — rollback produces history too.
        const client = await buildClient()
        let lastStatus = ""
        while (true) {
          await new Promise((r) => setTimeout(r, 1500))
          const detail = await fetch(
            `${client.baseURL}/v1/functions/deployments/${result.deployment.id}`,
            { headers: { Authorization: `Bearer ${client.apiKey}` } }
          )
          if (!detail.ok) {
            ui.warn(`Status poll failed (${detail.status}); will retry…`)
            continue
          }
          const body = (await detail.json()) as {
            deployment?: { status: string; errorMessage?: string | null }
          }
          const status = body.deployment?.status ?? ""
          if (status !== lastStatus) {
            ui.step(`status: ${status}`)
            lastStatus = status
          }
          if (status === "active") {
            await ui.scrambleSuccess(
              `Rolled back to v${result.rolledBackToVersion} in ${(
                (Date.now() - startedAt) /
                1000
              ).toFixed(1)}s`
            )
            if (result.previousDraft) {
              ui.hint(
                "Your previous draft was overwritten by the rollback. " +
                  "If you need it back, the CLI cached the last 5000 chars below:"
              )
              ui.hint(
                "  " + result.previousDraft.slice(0, 5000).replace(/\n/g, "\n  ")
              )
            }
            return
          }
          if (status === "failed") {
            fail(body.deployment?.errorMessage ?? "Rollback failed.")
          }
        }
      }
    )
}
