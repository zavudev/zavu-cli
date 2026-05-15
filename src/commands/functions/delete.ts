// `zavu fn delete` — permanently destroy a function and cascade everything
// it owns (triggers, secrets, managed agents/tools, deployment history, the
// auto API key, and the AWS Lambda).
//
// Confirmation is required EVERY time: the user must type the function slug
// to proceed. There's no `--force` / `-y` bypass — deleting a function while
// a teammate is iterating against it is a real foot-gun and the extra
// 3-second prompt is cheap insurance. If you need automation, hit the
// DELETE /v1/functions/:id endpoint directly with your API key.

import { Command } from "commander"
import prompts from "prompts"
import { buildClient } from "../../lib/client"
import { readProjectConfig } from "../../lib/config"
import { ui, fail, extractServerError } from "../../lib/ui"

interface DeletePayload {
  deleted: boolean
  name?: string
  slug?: string
}

export function functionsDeleteCommand(): Command {
  return new Command("delete")
    .alias("rm")
    .description(
      "Permanently delete a function and everything it owns. Asks for confirmation."
    )
    .argument(
      "[functionId]",
      "Function ID to delete. Defaults to the function in .zavu/config.json."
    )
    .action(async (functionIdArg?: string) => {
      const target = await resolveTarget(functionIdArg)
      const client = await buildClient()

      ui.warn(`About to delete function "${target.name}" (${target.slug}).`)
      ui.hint("This will cascade:")
      ui.hint("  • the deployed AWS Lambda")
      ui.hint("  • all triggers, secrets, deployment history")
      ui.hint("  • managed agents + tools created by defineAgent / defineTool")
      ui.hint("  • the auto-provisioned API key for this function")

      // Require typing the slug back. `prompts` returns `undefined` on Ctrl-C,
      // which we treat as a cancel.
      const res = await prompts({
        type: "text",
        name: "confirm",
        message: `Type "${target.slug}" to confirm:`,
      })
      if (!res.confirm) {
        ui.info("Cancelled.")
        return
      }
      if (res.confirm !== target.slug) {
        fail(`Confirmation didn't match. Expected "${target.slug}", got "${res.confirm}".`)
      }

      const httpRes = await fetch(
        `${client.baseURL}/v1/functions/${target.functionId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${client.apiKey}` },
        }
      )
      if (!httpRes.ok) {
        fail(
          await extractServerError(
            httpRes,
            `Delete rejected (${httpRes.status})`
          )
        )
      }
      const payload = (await httpRes.json().catch(() => ({}))) as DeletePayload
      ui.success(`Deleted "${payload.name ?? target.name}" (${payload.slug ?? target.slug}).`)
      ui.hint(
        "AWS Lambda + log group teardown runs in the background; check the console if you need to verify."
      )
    })
}

// Resolve the function the user wants to delete. Priority:
//   1. Explicit positional arg → fetch the function record (so we can ask
//      "type <slug>" using the real slug).
//   2. .zavu/config.json in cwd → use its functionId + slug + name.
async function resolveTarget(
  functionIdArg: string | undefined
): Promise<{ functionId: string; slug: string; name: string }> {
  if (functionIdArg) {
    const client = await buildClient()
    const res = await fetch(
      `${client.baseURL}/v1/functions/${functionIdArg}`,
      { headers: { Authorization: `Bearer ${client.apiKey}` } }
    )
    if (!res.ok) {
      fail(await extractServerError(res, `Could not load ${functionIdArg}`))
    }
    const body = (await res.json()) as {
      function?: { id: string; slug: string; name: string }
    }
    const fn = body.function
    if (!fn?.id) fail("Server returned no function record.")
    return { functionId: fn!.id, slug: fn!.slug, name: fn!.name }
  }
  const cfg = await readProjectConfig()
  if (!cfg) {
    fail(
      "No function ID provided and no .zavu/config.json in cwd. Pass `zavu fn delete <functionId>` or run from a function directory."
    )
  }
  return { functionId: cfg!.functionId, slug: cfg!.slug, name: cfg!.name }
}
