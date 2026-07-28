// `npx zavudev functions logs` — fetch / tail CloudWatch logs for the deployed function
// via Zavu's API. The same data shown in the dashboard's Logs tab.

import { Command } from "commander"
import { buildClient } from "../../lib/client"
import { readProjectConfig } from "../../lib/config"
import { ui, fail, cli } from "../../lib/ui"

interface LogsOpts {
  tail?: boolean
  since?: string
  filter?: string
  limit: string
}

export function functionsLogsCommand(): Command {
  return new Command("logs")
    .description("Fetch (or tail) recent invocation logs for the function in cwd.")
    .option("-t, --tail", "Keep streaming new events as they arrive")
    .option("--since <duration>", "Only show events newer than this (e.g. 5m, 1h)", "30m")
    .option("--filter <pattern>", "CloudWatch filter pattern")
    .option("--limit <n>", "Max events per page", "100")
    .action(async (opts: LogsOpts) => {
      const config = await readProjectConfig()
      if (!config) {
        fail("No .zavu/config.json found. Run inside a function directory or `npx zavudev functions init` first.")
      }
      const client = await buildClient()

      // AbortController lets us close the in-flight fetch the moment the user
      // hits Ctrl-C. Without this, the polling fetch keeps the request open
      // until the server hangup, which shows up in Convex logs as
      // `Client disconnected` (cosmetic but alarming during dev).
      const ctrl = new AbortController()
      let interrupted = false
      const onSigint = () => {
        interrupted = true
        ctrl.abort()
        // Newline so the next shell prompt doesn't collide with our last log line.
        process.stdout.write("\n")
        process.exit(0)
      }
      process.on("SIGINT", onSigint)
      process.on("SIGTERM", onSigint)

      // Adaptive backoff so an idle tail doesn't hammer Convex + CloudWatch:
      //   • When events arrive → poll fast (3s) so iteration feels live.
      //   • Each empty poll bumps the interval up to MAX (30s).
      //   • Any event resets back to MIN.
      // For a Lambda that's silent most of the time, this drops the call
      // volume from 1200/hr to ~120/hr — same UX when something happens.
      const POLL_MIN_MS = 3_000
      const POLL_MAX_MS = 30_000
      let pollMs = POLL_MIN_MS

      let lastTimestamp = Date.now() - parseDurationMs(opts.since ?? "30m")
      try {
        do {
          const url = new URL(`${client.baseURL}/v1/functions/${config!.functionId}/logs`)
          url.searchParams.set("startTime", String(lastTimestamp))
          url.searchParams.set("limit", opts.limit)
          if (opts.filter) url.searchParams.set("filterPattern", opts.filter)

          let res: Response
          try {
            res = await fetch(url.toString(), {
              headers: { Authorization: `Bearer ${client.apiKey}` },
              signal: ctrl.signal,
            })
          } catch (err) {
            // AbortError on Ctrl-C — exit cleanly. Any other transient error
            // (network blip) we retry after a back-off.
            if (interrupted || (err as Error)?.name === "AbortError") break
            ui.warn(`Log fetch errored; will retry…`)
            await sleep(POLL_MAX_MS)
            continue
          }
          if (!res.ok) {
            ui.warn(`Log fetch failed (${res.status}); will retry…`)
            await sleep(POLL_MAX_MS)
            continue
          }
          // The API serializes timestamps as ISO strings (`new Date(...).toISOString()`),
          // not epoch millis. Parse back to a number for the tail cursor — otherwise
          // `Math.max(num, "2026-…" + 1)` poisons lastTimestamp with NaN and the
          // next request sends `?startTime=NaN`, which CloudWatch rejects with
          // "STRING_VALUE can not be converted to a Long".
          const { events = [] } = (await res.json()) as {
            events: Array<{ timestamp: string; message: string }>
          }
          let printed = 0
          for (const e of events) {
            if (isCeremony(e.message)) continue
            const tsMs = Date.parse(e.timestamp)
            process.stdout.write(`${e.timestamp}  ${cleanMessage(e.message).replace(/\n$/, "")}\n`)
            if (Number.isFinite(tsMs)) {
              lastTimestamp = Math.max(lastTimestamp, tsMs + 1)
            }
            printed++
          }
          if (opts.tail) {
            // Reset to fast polling on activity; double on idle until the cap.
            pollMs = printed > 0 ? POLL_MIN_MS : Math.min(pollMs * 2, POLL_MAX_MS)
            await sleep(pollMs)
          } else if (printed === 0) {
            // Printing nothing and exiting 0 is indistinguishable from a broken
            // command. Say which window was searched, since the usual cause is
            // that the function simply has not run inside it.
            ui.info(`No logs in the last ${opts.since}.`)
            ui.hint(`Widen it with ${cli("fn logs --since 24h")}, or follow live with ${cli("fn logs --tail")}.`)
          }
        } while (opts.tail && !interrupted)
      } finally {
        process.off("SIGINT", onSigint)
        process.off("SIGTERM", onSigint)
      }
    })
}

const CEREMONY_PREFIXES = [
  "INIT_START",
  "INIT_REPORT",
  "START RequestId",
  "END RequestId",
  "REPORT RequestId",
  "EXTENSION",
  "TELEMETRY",
]

function isCeremony(msg: string): boolean {
  const trimmed = msg.trim()
  return CEREMONY_PREFIXES.some((p) => trimmed.startsWith(p))
}

function cleanMessage(msg: string): string {
  return msg
    .replace(/arn:[a-z-]+:[a-z0-9-]+:[a-z0-9-]*:[0-9]*:[^\s"'\\]+/gi, "[runtime-resource]")
    .replace(/\/opt\/nodejs\/node_modules\//g, "/")
    .replace(/\/var\/task\//g, "/")
}

function parseDurationMs(input: string): number {
  const match = input.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return 30 * 60 * 1000
  const n = Number(match[1])
  const u = match[2]
  return u === "s" ? n * 1000 : u === "m" ? n * 60_000 : u === "h" ? n * 3_600_000 : n * 86_400_000
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
