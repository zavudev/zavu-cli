// Shared deploy runner: POST the source to the deploy pipeline and stream
// status until terminal. Used by `zavudev deploy` and `zavudev import` so the
// two commands cannot drift in how they report a deploy.

import { buildApi } from "./api"
import { ui, fail, extractServerError } from "./ui"

// Shape of `deployment.reconcileSummary` from the backend. Populated when the
// user's source code calls `defineAgent` / `defineTool` — undefined / null
// when there's nothing to sync (then we render nothing).
export interface ReconcileSummary {
  agentsCreated: string[]
  agentsUpdated: string[]
  /** Present since the reconcile learned to diff. Older servers omit it. */
  agentsUnchanged?: string[]
  agentsDeleted: string[]
  toolsCreated: string[]
  toolsUpdated: string[]
  toolsUnchanged?: string[]
  toolsDeleted: string[]
  /** Present since defineAgent learned to declare a knowledge base. */
  knowledgeCreated?: string[]
  knowledgeUpdated?: string[]
  flowsCreated?: string[]
  flowsUpdated?: string[]
  flowsDeleted?: string[]
  knowledgeDeleted?: string[]
  warnings: string[]
  /**
   * Synced correctly and still broken — an agent no channel can reach, say.
   * Optional because an older server does not send it.
   */
  errors?: string[]
}

export function printReconcileSummary(
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
    // Knowledge bases only. The documents inside them are synced after this
    // returns, so no per-document line can appear here: the previous version
    // printed one for re-embedded documents against a list the server never
    // fills, which read as "nothing was re-embedded" on every deploy.
    const knowledgeTouched =
      (summary.knowledgeCreated?.length ?? 0) + (summary.knowledgeDeleted?.length ?? 0)
    if (knowledgeTouched > 0) {
      ui.info("Knowledge bases:")
      for (const n of summary.knowledgeCreated ?? []) ui.hint(`  + ${n}`)
      for (const n of summary.knowledgeDeleted ?? []) ui.hint(`  - ${n}`)
      ui.hint("  documents sync in the background; check with `agents knowledge-bases documents list`")
    }
    const flowsTouched =
      (summary.flowsCreated?.length ?? 0) +
      (summary.flowsUpdated?.length ?? 0) +
      (summary.flowsDeleted?.length ?? 0)
    if (flowsTouched > 0) {
      ui.info("Flows synced:")
      for (const n of summary.flowsCreated ?? []) ui.hint(`  + ${n} (disabled)`)
      for (const n of summary.flowsUpdated ?? []) ui.hint(`  ~ ${n}`)
      for (const n of summary.flowsDeleted ?? []) ui.hint(`  - ${n}`)
      if ((summary.flowsCreated?.length ?? 0) > 0) {
        ui.hint("  a new flow starts disabled; enable it with `agents flows update <id> --enabled`")
      }
    }
    for (const w of summary.warnings) ui.warn(w)
    // After the warnings, because it is the line that has to be acted on.
    for (const e of summary.errors ?? []) ui.error(e)
  }
  if (warning) ui.warn(`manifest probe: ${warning}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface DeployArgs {
  client: { baseURL: string; apiKey: string }
  functionId: string
  /** For the progress line, e.g. `My Bot (my-bot)`. */
  label: string
  /** The project tree, keyed by path relative to the project root. */
  files?: Record<string, string>
  entrypoint?: string
  /** Single-file form, for callers that produce one module (the eve compiler). */
  sourceCode?: string
  dependencies: Record<string, string>
  architecture?: "arm64" | "x86_64"
  updateRuntime?: boolean
}

/**
 * Deploy and poll to a terminal state. Prints progress and the reconcile
 * summary; sets `process.exitCode = 1` when the function went live but its
 * declarations failed to sync (a "successful" deploy that must not read as
 * one to scripts).
 */
/**
 * Print the build output of the most recent failed deployment, if there is one.
 *
 * Used when the deploy REQUEST fails rather than the deployment: the row is
 * written before the action throws, so the compiler's message is already
 * stored — just not in the response. Two fetches because the list deliberately
 * omits build logs (one log per row would be megabytes).
 *
 * Best effort throughout. This runs while reporting an error, and failing to
 * decorate an error must never replace it with a different one.
 */
async function printLastBuildFailure(args: DeployArgs): Promise<void> {
  try {
    const headers = { Authorization: `Bearer ${args.client.apiKey}` }
    const listRes = await fetch(
      `${args.client.baseURL}/v1/functions/${args.functionId}/deployments?limit=1`,
      { headers }
    )
    if (!listRes.ok) return
    const list = (await listRes.json()) as {
      deployments?: Array<{ id: string; status: string }>
    }
    const latest = list.deployments?.[0]
    if (!latest || latest.status !== "failed") return

    const detailRes = await fetch(
      `${args.client.baseURL}/v1/functions/deployments/${latest.id}`,
      { headers }
    )
    if (!detailRes.ok) return
    const detail = (await detailRes.json()) as {
      deployment?: { buildLogs?: string | null; errorMessage?: string | null }
    }
    const logs = detail.deployment?.buildLogs?.trim() || detail.deployment?.errorMessage?.trim()
    if (!logs) return

    ui.info("Build output:")
    for (const line of logs.split("\n")) ui.hint(`  ${line}`)
  } catch {
    // Nothing to add. The server's own error still gets reported.
  }
}

export async function deployAndWait(args: DeployArgs): Promise<void> {
  ui.step(`Deploying ${args.label}…`)
  const startedAt = Date.now()

  const res = await fetch(`${args.client.baseURL}/v1/functions/${args.functionId}/deploy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.client.apiKey}`,
    },
    body: JSON.stringify({
      ...(args.files ? { files: args.files } : {}),
      ...(args.entrypoint ? { entrypoint: args.entrypoint } : {}),
      ...(args.sourceCode !== undefined ? { sourceCode: args.sourceCode } : {}),
      dependencies: args.dependencies,
      ...(args.architecture ? { architecture: args.architecture } : {}),
      ...(args.updateRuntime ? { updateRuntime: true } : {}),
    }),
  })
  if (!res.ok) {
    const serverError = await extractServerError(
      res,
      `Deploy request rejected (${res.status})`
    )
    // A build that breaks fails the request itself, and the message that comes
    // back out of the action is the outer wrapper's: "Build Worker failed",
    // with the compiler's actual complaint left behind. But the attempt was
    // recorded before it threw, so the useful text is one fetch away.
    await printLastBuildFailure(args)
    fail(serverError)
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
      `${args.client.baseURL}/v1/functions/deployments/${deploymentId}`,
      { headers: { Authorization: `Bearer ${args.client.apiKey}` } }
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
        buildLogs?: string | null
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
      // A reconcile error means something in the source is live and broken —
      // an agent no message can reach, say. It synced, so it is not the
      // manifest-probe failure below, and it is emphatically not a green tick.
      const reconcileErrors = d.reconcileSummary?.errors ?? []
      if (d.reconcileWarning || reconcileErrors.length > 0) {
        ui.warn(`Deployed with errors in ${elapsed}.`)
      } else {
        await ui.scrambleSuccess(`Deployed in ${elapsed}`)
      }
      // The URL lives on the server, not in .zavu/config.json — which is
      // written at scaffold time and never carries it.
      try {
        const api = await buildApi()
        const fn = await api.get<{
          function?: { httpEnabled?: boolean; publicUrl?: string | null }
        }>(`/v1/functions/${args.functionId}`)
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
      } else if (reconcileErrors.length > 0) {
        // Everything synced, and something in it cannot work. A script that
        // only reads the exit code must not be told this went fine — that is
        // exactly how an unreachable agent stays unreachable for a week.
        ui.warn(
          "Your declarations synced, but the deploy above is not usable as-is. Fix what is listed and deploy again."
        )
        process.exitCode = 1
      }
      return
    }
    if (d.status === "failed") {
      // Print what the build printed before giving up.
      //
      // The status message is often the outer wrapper's ("Build Worker
      // failed: [invalid_request]"), which names nothing you can act on. The
      // compiler's own output — the unresolved import, the syntax error, the
      // package that would not install — is in the logs, and without it the
      // only way forward is guessing.
      const logs = d.buildLogs?.trim()
      if (logs) {
        ui.info("Build output:")
        for (const line of logs.split("\n")) ui.hint(`  ${line}`)
      }
      fail(d.errorMessage ?? "Deploy failed.")
    }
  }
}
