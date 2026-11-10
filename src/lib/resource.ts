// Generic CRUD command factory.
//
// Most Zavu API resources expose the same 4 verbs over REST: list, get one by
// id, create, delete. Hand-writing all of them per resource is tedious and
// drifts; this helper turns a small descriptor into a Commander subcommand
// tree. Resources that need extra verbs (broadcasts/send, brands/submit,
// templates/submit, etc.) pass a `customize` callback that mounts them.

import { Command } from "commander"
import { buildApi, ApiClient } from "./api"
import { ui, fail } from "./ui"

type Formatter = (item: any) => Record<string, string>

export interface ResourceConfig {
  name: string                      // command name e.g. "senders"
  description: string               // help text
  basePath: string                  // e.g. "/v1/senders"
  itemKey?: string                  // single-item response wrapper key (e.g. "sender")
  listKey?: string                  // list response wrapper key (default "items")
  format?: Formatter                // table row formatter (default: id/name/status)
  idArg?: string                    // arg label e.g. "senderId" (default "id")
  list?: boolean                    // include `list` (default true)
  get?: boolean                     // include `get <id>` (default true)
  create?: boolean                  // include `create --json …`
  remove?: boolean                  // include `delete <id>`
  customize?: (cmd: Command, api: () => Promise<ApiClient>) => void
}

const defaultFormat: Formatter = (item) => ({
  id: String(item?.id ?? "—"),
  name: String(item?.name ?? item?.displayName ?? item?.slug ?? "—"),
  status: String(item?.status ?? item?.state ?? "—"),
})

// Pull the canonical list/single payload out regardless of whether the API
// wraps it (`{ sender: {...} }`, `{ items: [...] }`) or returns it raw.
function unwrapItem<T>(payload: any, key?: string): T {
  if (key && payload && typeof payload === "object" && key in payload) return payload[key]
  return payload
}
function unwrapList<T>(payload: any, key = "items"): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (payload && typeof payload === "object" && Array.isArray(payload[key])) {
    return payload[key] as T[]
  }
  return []
}

export function defineResource(cfg: ResourceConfig): Command {
  const cmd = new Command(cfg.name).description(cfg.description)
  const apiFactory = () => buildApi()
  const idArg = cfg.idArg ?? "id"

  if (cfg.list !== false) {
    cmd
      .command("list")
      .description(`List ${cfg.name}.`)
      .option("--limit <n>", "Page size", "20")
      .option("--cursor <cursor>", "Pagination cursor")
      .option("--json", "Print as JSON")
      .action(async (opts: { limit: string; cursor?: string; json?: boolean }) => {
        const api = await apiFactory()
        try {
          const result = await api.get<any>(cfg.basePath, {
            limit: opts.limit,
            cursor: opts.cursor,
          })
          const items = unwrapList<any>(result, cfg.listKey)
          if (opts.json) {
            process.stdout.write(JSON.stringify(result, null, 2) + "\n")
            return
          }
          if (items.length === 0) {
            ui.info(`No ${cfg.name} found.`)
            return
          }
          ui.table(items.map(cfg.format ?? defaultFormat))
          if (result?.nextCursor) {
            ui.hint(`More: --cursor ${result.nextCursor}`)
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
        }
      })
  }

  if (cfg.get !== false) {
    cmd
      .command(`get <${idArg}>`)
      .description(`Retrieve a ${singularize(cfg.name)} by ID.`)
      .option("--json", "Print as JSON")
      .action(async (id: string, opts: { json?: boolean }) => {
        const api = await apiFactory()
        try {
          const result = await api.get<any>(`${cfg.basePath}/${encodeURIComponent(id)}`)
          const item = unwrapItem<any>(result, cfg.itemKey)
          process.stdout.write(JSON.stringify(opts.json ? result : item, null, 2) + "\n")
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
        }
      })
  }

  if (cfg.create) {
    cmd
      .command("create")
      .description(
        `Create a ${singularize(cfg.name)}. Body must be valid JSON.`
      )
      .option("--data <json>", "Inline JSON body")
      .option("--file <path>", "Path to a JSON file")
      .option("--json", "Print full response")
      .action(async (opts: { data?: string; file?: string; json?: boolean }) => {
        const body = await loadJsonBody(opts)
        const api = await apiFactory()
        try {
          const result = await api.post<any>(cfg.basePath, body)
          const item = unwrapItem<any>(result, cfg.itemKey)
          if (opts.json) {
            process.stdout.write(JSON.stringify(result, null, 2) + "\n")
            return
          }
          ui.success(`Created ${item?.id ?? "(no id)"}`)
          process.stdout.write(JSON.stringify(item, null, 2) + "\n")
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
        }
      })
  }

  if (cfg.remove) {
    cmd
      .command(`delete <${idArg}>`)
      .description(`Delete a ${singularize(cfg.name)}.`)
      .action(async (id: string) => {
        const api = await apiFactory()
        try {
          await api.del(`${cfg.basePath}/${encodeURIComponent(id)}`)
          ui.success(`Deleted ${id}`)
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
        }
      })
  }

  if (cfg.customize) cfg.customize(cmd, apiFactory)
  return cmd
}

function singularize(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y"
  if (name.endsWith("ses")) return name.slice(0, -2)
  if (name.endsWith("s")) return name.slice(0, -1)
  return name
}

export async function loadJsonBody(opts: { data?: string; file?: string }): Promise<unknown> {
  if (opts.data) {
    try {
      return JSON.parse(opts.data)
    } catch (err) {
      fail(`--data is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (opts.file) {
    const { readFile } = await import("node:fs/promises")
    const raw = await readFile(opts.file, "utf8")
    try {
      return JSON.parse(raw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // The single most common mistake when writing a JSON file by hand is a
      // multi-line string from a heredoc — JSON disallows raw \n inside
      // strings. Detect that specific case and explain how to fix it.
      const hint = /unterminated string/i.test(msg)
        ? "\n  Hint: a string in the file spans multiple lines. JSON strings " +
          "can't contain raw newlines — join the lines into one, or escape " +
          "them as \\n."
        : ""
      fail(`${opts.file} is not valid JSON: ${msg}${hint}`)
    }
  }
  fail("Provide --data '<json>' or --file <path>.")
}

// Generic helper for action endpoints (POST verb on a sub-resource path with no
// or trivial body). Shared by `submit`, `cancel`, `sync`, etc.
export function actionCommand(
  parent: Command,
  apiFactory: () => Promise<ApiClient>,
  spec: {
    name: string
    description: string
    idArg?: string
    pathSuffix: string // e.g. "/submit"
    method?: "POST" | "DELETE"
  }
): void {
  const idArg = spec.idArg ?? "id"
  const method = spec.method ?? "POST"
  parent
    .command(`${spec.name} <${idArg}>`)
    .description(spec.description)
    .action(async (id: string) => {
      const api = await apiFactory()
      try {
        const path = `/v1${spec.pathSuffix.replace("{id}", encodeURIComponent(id))}`
        const result =
          method === "POST" ? await api.post<any>(path) : await api.del<any>(path)
        ui.success(`${spec.name} ok`)
        if (result) process.stdout.write(JSON.stringify(result, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}
