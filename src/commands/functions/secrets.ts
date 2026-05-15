// `zavu fn secrets …` — manage env vars on a Zavu Function.
//
// Operates on the function in cwd by default (via .zavu/config.json), so
// from the function directory you just type `zavu fn secrets set FOO bar`.
// Pass --function <id> to target another function without cd'ing.
//
// Plaintext NEVER leaves the server side after a set — list only shows the
// last 4 chars per value, matching the dashboard behaviour. The value can be
// passed inline, read from a file (--from-file), or piped through stdin (-)
// which is the safest path for keys you don't want in shell history.

import { Command } from "commander"
import { readFile } from "node:fs/promises"
import { buildClient } from "../../lib/client"
import { readProjectConfig } from "../../lib/config"
import { ui, fail, extractServerError } from "../../lib/ui"

interface SecretRow {
  id: string
  key: string
  valueLast4: string
  syncedToAws?: boolean
  updatedAt?: number
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

// Resolve the raw value for `set` from the three accepted sources:
// inline arg, --from-file, or `-` to mean stdin. Exactly one must be present
// — passing both raises immediately so the user doesn't get a silent winner.
async function resolveValue(
  inlineValue: string | undefined,
  fromFile: string | undefined
): Promise<string> {
  if (inlineValue !== undefined && fromFile !== undefined) {
    fail("Pass either a value or --from-file, not both.")
  }
  let result: string
  let source: string
  if (fromFile) {
    result = (await readFile(fromFile, "utf8")).trimEnd()
    source = `--from-file ${fromFile}`
  } else if (inlineValue === "-") {
    // Read entire stdin (works for `cat secret | zavu fn secrets set KEY -`).
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    result = Buffer.concat(chunks).toString("utf8").trimEnd()
    source = "stdin"
  } else if (inlineValue === undefined || inlineValue === "") {
    fail(
      "Pass a value as an argument, --from-file <path>, or '-' to read stdin.\n" +
        "  Example: zavu fn secrets set OPENAI_API_KEY sk-...\n" +
        "  Or:      cat key.txt | zavu fn secrets set OPENAI_API_KEY -"
    )
    return "" // unreachable, satisfies TS
  } else {
    result = inlineValue
    source = "argument"
  }
  if (result.length === 0) {
    fail(`Secret value from ${source} is empty after trimming whitespace.`)
  }
  return result
}

export function functionsSecretsCommand(): Command {
  const cmd = new Command("secrets")
    .alias("secret")
    .description("Manage environment variables for this function.")

  cmd
    .command("list")
    .description("Show all secret keys on the function (values are never exposed).")
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .option("--json", "Print as JSON")
    .action(async (opts: { function?: string; json?: boolean }) => {
      const functionId = await resolveFunctionId(opts.function)
      const res = await api<{ secrets: SecretRow[] }>(
        "GET",
        `/v1/functions/${functionId}/secrets`
      )
      if (opts.json) {
        process.stdout.write(JSON.stringify(res.secrets, null, 2) + "\n")
        return
      }
      if (res.secrets.length === 0) {
        ui.info("No secrets set on this function.")
        return
      }
      ui.table(
        res.secrets.map((s) => ({
          key: s.key,
          value: `…${s.valueLast4}`,
          synced: s.syncedToAws ? "yes" : "no",
        }))
      )
      const stale = res.secrets.filter((s) => !s.syncedToAws).length
      if (stale > 0) {
        ui.hint(
          `${stale} secret${stale === 1 ? "" : "s"} not yet pushed to Lambda — run \`zavu deploy\` to sync.`
        )
      }
    })

  cmd
    .command("set <key> [value]")
    .description("Set a secret. Use '-' as value to read from stdin (safer).")
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .option("--from-file <path>", "Read value from a file instead of arg")
    .action(
      async (
        key: string,
        value: string | undefined,
        opts: { function?: string; fromFile?: string }
      ) => {
        const functionId = await resolveFunctionId(opts.function)
        const raw = await resolveValue(value, opts.fromFile)
        const res = await api<{
          secret: {
            key: string
            valueLast4: string
            created: boolean
          }
        }>(
          "PUT",
          `/v1/functions/${functionId}/secrets/${encodeURIComponent(key)}`,
          { value: raw }
        )
        const verb = res.secret.created ? "Created" : "Updated"
        ui.success(`${verb} ${res.secret.key} (…${res.secret.valueLast4})`)
        ui.hint(
          "Lambda env var updates on the next `zavu deploy`. Run it now to apply."
        )
      }
    )

  cmd
    .command("unset <key>")
    .alias("rm")
    .description("Remove a secret.")
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .action(async (key: string, opts: { function?: string }) => {
      const functionId = await resolveFunctionId(opts.function)
      await api(
        "DELETE",
        `/v1/functions/${functionId}/secrets/${encodeURIComponent(key)}`
      )
      ui.success(`Removed ${key}`)
      ui.hint("Run `zavu deploy` to push the change to Lambda.")
    })

  return cmd
}
