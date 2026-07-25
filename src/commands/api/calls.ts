// Voice calls placed and answered by a sender's voice agent.
//
// Voice was the only major product with no CLI surface at all: you could not
// list calls, read a transcript, or hang one up without hand-rolling REST.
// That hurts most on voice specifically, because a call leaves nothing behind
// except its transcript — when an agent says the wrong thing, this is the only
// place to find out what it actually said.

import { Command } from "commander"
import { buildApi } from "../../lib/api"
import { ui, fail } from "../../lib/ui"

interface Turn {
  seq: number
  role: "user" | "assistant" | "tool"
  text: string
}

export function callsCommand(): Command {
  const cmd = new Command("calls").description("Voice calls handled by your agents.")

  cmd
    .command("list")
    .description("List calls, most recent first.")
    .option("--status <status>", "queued | ringing | in_progress | completed | failed | busy | no_answer | canceled")
    .option("--direction <dir>", "inbound | outbound")
    .option("--limit <n>", "Page size", "20")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: any[] }>("/v1/calls", {
          status: opts.status,
          direction: opts.direction,
          limit: opts.limit,
        })
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        if (!res.items?.length) {
          ui.info("No calls found.")
          return
        }
        ui.table(
          res.items.map((c) => ({
            id: c.id,
            direction: c.direction,
            from: c.from,
            to: c.to,
            status: c.status,
            // Zero is a real duration (nobody spoke), so don't render it as "—".
            seconds: typeof c.durationSeconds === "number" ? String(c.durationSeconds) : "—",
            reason: c.endReason ?? "—",
          }))
        )
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("get <callId>")
    .description("Show a call, including its transcript.")
    .option("--json", "Print the raw JSON response")
    .action(async (callId, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ call: any }>(`/v1/calls/${callId}`)
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        const c = res.call
        ui.info(`${c.direction} · ${c.from} → ${c.to} · ${c.status}`)
        if (typeof c.durationSeconds === "number") {
          ui.hint(`${c.durationSeconds}s${c.endReason ? ` · ended: ${c.endReason}` : ""}`)
        }
        if (typeof c.cost === "number") ui.hint(`cost: $${c.cost.toFixed(4)}`)
        const turns: Turn[] = c.transcript ?? []
        if (!turns.length) {
          ui.hint("No transcript. It appears once the conversation produces turns.")
          return
        }
        process.stdout.write("\n")
        for (const t of turns) {
          const who = t.role === "assistant" ? "agent" : t.role === "user" ? "caller" : "tool"
          process.stdout.write(`${who.padEnd(6)} │ ${t.text}\n`)
        }
        process.stdout.write("\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("create")
    .description("Place an outbound call. COSTS MONEY — billed per minute plus telephony.")
    .requiredOption("--to <e164>", "Recipient phone number in E.164 format")
    .option("--sender <senderId>", "Sender placing the call (defaults to the project default)")
    .option("--greeting <text>", "Override the agent's greeting, this call only")
    .option("--language <tag>", "BCP-47 tag, or 'auto' to follow the caller")
    .option("--max-minutes <n>", "Override the agent's max call duration")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.post<{ call: any }>("/v1/calls", {
          to: opts.to,
          ...(opts.sender ? { senderId: opts.sender } : {}),
          ...(opts.greeting ? { greeting: opts.greeting } : {}),
          ...(opts.language ? { language: opts.language } : {}),
          ...(opts.maxMinutes ? { maxDurationMinutes: Number(opts.maxMinutes) } : {}),
        })
        ui.success(`Dialing ${res.call.to}`)
        ui.hint(`call id: ${res.call.id} — follow it with \`zavu calls get ${res.call.id}\``)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("hangup <callId>")
    .description("End a call that is ringing or in progress.")
    .action(async (callId) => {
      const api = await buildApi()
      try {
        await api.post(`/v1/calls/${callId}/hangup`)
        ui.success("Hang up accepted.")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  return cmd
}
