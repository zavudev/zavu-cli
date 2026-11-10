// `npx zavudev functions push` — sync local source + dependencies to the function's
// draft without triggering a deploy. Fast (single PATCH, no Build Worker, no
// Lambda update). Use this for "save my progress" and let the dashboard show
// the latest code; use `npx zavudev functions deploy` when you actually want the
// running function to change.

import { Command } from "commander"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { buildClient } from "../../lib/client"
import { readProjectConfig } from "../../lib/config"
import { ui, fail, extractServerError } from "../../lib/ui"

export function functionsPushCommand(): Command {
  return new Command("push")
    .description("Sync local code to the function draft (no deploy).")
    .option("--source <file>", "Source file relative to cwd", "index.ts")
    .option("--no-deps", "Don't send package.json dependencies")
    .action(async (opts: { source: string; deps: boolean }) => {
      const config = await readProjectConfig()
      if (!config) {
        fail(
          "No .zavu/config.json found. Run `npx zavudev functions init` first or `cd` into a function directory."
        )
      }
      const client = await buildClient()

      let sourceCode: string
      try {
        sourceCode = await readFile(join(process.cwd(), opts.source), "utf8")
      } catch {
        fail(
          `Could not read ${opts.source}. Pass --source <file> if your entrypoint is named differently.`
        )
      }

      const body: { sourceCode: string; dependencies?: Record<string, string> } = {
        sourceCode: sourceCode!,
      }
      if (opts.deps) {
        try {
          const pkgRaw = await readFile(join(process.cwd(), "package.json"), "utf8")
          const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string> }
          body.dependencies = pkg.dependencies ?? {}
        } catch {
          // No package.json — fine, just push code.
        }
      }

      ui.step(`Pushing draft for ${config!.name} (${config!.slug})…`)
      const res = await fetch(
        `${client.baseURL}/v1/functions/${config!.functionId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${client.apiKey}`,
          },
          body: JSON.stringify(body),
        }
      )
      if (!res.ok) {
        fail(await extractServerError(res, `Push rejected (${res.status})`))
      }
      await ui.scrambleSuccess("Draft updated.")
      ui.hint("Run `npx zavudev functions deploy` when you're ready to publish.")
    })
}
