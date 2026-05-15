// `zavu functions triggers …` — bind a function to Zavu events.
//
// A trigger is a (functionId, eventType, senderId?) tuple. When the named
// event fires for the matching sender (or any sender if senderId is omitted),
// the dispatcher invokes this function's Lambda with the event payload.
//
// Most commands operate on the function in cwd (read from .zavu/config.json),
// so you don't have to pass --function every time.

import { Command } from "commander"
import { buildClient } from "../../lib/client"
import { readProjectConfig } from "../../lib/config"
import { ui, fail, extractServerError } from "../../lib/ui"

interface Trigger {
  id: string
  eventType: string
  senderId: string | null
  active: boolean
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

export function functionsTriggersCommand(): Command {
  const cmd = new Command("triggers")
    .alias("trigger")
    .description("Manage which Zavu events fire this function.")

  cmd
    .command("list")
    .description("Show all triggers attached to the function.")
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .option("--json", "Print as JSON")
    .action(async (opts: { function?: string; json?: boolean }) => {
      const functionId = await resolveFunctionId(opts.function)
      const res = await api<{ triggers: Trigger[] }>(
        "GET",
        `/v1/functions/${functionId}/triggers`
      )
      if (opts.json) {
        process.stdout.write(JSON.stringify(res.triggers, null, 2) + "\n")
        return
      }
      if (res.triggers.length === 0) {
        ui.info("No triggers. Add some with `zavu functions triggers add`.")
        return
      }
      ui.table(
        res.triggers.map((t) => ({
          id: t.id,
          event: t.eventType,
          sender: t.senderId ?? "(any)",
          active: t.active ? "yes" : "no",
        }))
      )
    })

  cmd
    .command("events")
    .description("List all event types this project supports.")
    .action(async () => {
      const res = await api<{ events: string[] }>("GET", "/v1/functions/event-types")
      for (const e of res.events) process.stdout.write(`${e}\n`)
    })

  cmd
    .command("add")
    .description(
      "Bind events to the function. Cartesian over --events × --senders."
    )
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .requiredOption(
      "--events <list>",
      "Comma-separated event types (e.g. message.inbound,message.delivered)"
    )
    .option(
      "--senders <list>",
      "Comma-separated sender IDs. Use 'any' as an entry for 'all senders'.",
      "any"
    )
    .action(async (opts: { function?: string; events: string; senders: string }) => {
      const functionId = await resolveFunctionId(opts.function)
      const eventTypes = opts.events
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const senderIds = opts.senders
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.toLowerCase() === "any" ? null : s))

      if (eventTypes.length === 0) fail("Pass at least one --events entry.")
      if (senderIds.length === 0) fail("Pass at least one --senders entry (or 'any').")

      const res = await api<{
        added: number
        skipped: number
        triggers: Trigger[]
      }>("POST", `/v1/functions/${functionId}/triggers`, {
        eventTypes,
        senderIds,
      })
      ui.success(
        `Added ${res.added} trigger${res.added === 1 ? "" : "s"}` +
          (res.skipped ? ` (${res.skipped} already existed)` : "")
      )
      ui.table(
        res.triggers.map((t) => ({
          id: t.id,
          event: t.eventType,
          sender: t.senderId ?? "(any)",
          active: t.active ? "yes" : "no",
        }))
      )
    })

  cmd
    .command("toggle <triggerId>")
    .description("Enable or disable a trigger.")
    .option("--off", "Disable instead of enable")
    .action(async (triggerId: string, opts: { off?: boolean }) => {
      const active = !opts.off
      await api("PATCH", `/v1/functions/triggers/${triggerId}`, { active })
      ui.success(active ? "Enabled." : "Disabled.")
    })

  cmd
    .command("remove <triggerId>")
    .alias("rm")
    .description("Delete a trigger.")
    .action(async (triggerId: string) => {
      await api("DELETE", `/v1/functions/triggers/${triggerId}`)
      ui.success("Removed.")
    })

  return cmd
}
