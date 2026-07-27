import { Command } from "commander"
import { defineResource, loadJsonBody } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

export const phoneNumbersCommand = (): Command =>
  defineResource({
    name: "phone-numbers",
    description: "Buy and manage phone numbers (SMS, voice).",
    basePath: "/v1/phone-numbers",
    itemKey: "phoneNumber",
    idArg: "phoneNumberId",
    remove: true, // DELETE = release
    format: (p) => ({
      id: p.id,
      number: p.phoneNumber,
      name: p.name ?? "—",
      status: p.status ?? "—",
      sender: p.senderId ?? "—",
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("search")
        .description("Search available numbers to purchase.")
        .requiredOption("--country <iso>", "Two-letter ISO country code (e.g. US)")
        .option("--type <type>", "local | mobile | tollFree")
        .option("--contains <pattern>", "Search digits inside the number")
        .option("--capabilities <list>", "Only numbers with all of these: sms, voice, mms")
        .option("--limit <n>", "Max results", "10")
        .option("--json", "Print the raw JSON response")
        .action(async (opts) => {
          const api = await apiFactory()
          try {
            const res = await api.get<{ items: any[] }>("/v1/phone-numbers/available", {
              countryCode: opts.country,
              type: opts.type,
              contains: opts.contains,
              capabilities: opts.capabilities,
              limit: opts.limit,
            })
            if (opts.json) {
              process.stdout.write(JSON.stringify(res, null, 2) + "\n")
              return
            }
            if (!res.items?.length) {
              ui.info("No numbers available.")
              return
            }
            // `$0` is a real, and very good, price — a free number must never
            // render as "—". A truthiness check here showed every free number
            // as "price unknown", which is the exact opposite of the truth and
            // hides the cheapest way to start.
            const price = (v: unknown) =>
              typeof v === "number" ? (v === 0 ? "free" : `$${v}`) : "—"
            // Which channels the number can carry decides whether it is any use
            // at all — a voice agent on an SMS-only number simply never rings.
            const caps = (c: Record<string, boolean> | undefined) => {
              if (!c) return "—"
              const on = Object.keys(c).filter((k) => c[k])
              return on.length ? on.join(",") : "none"
            }
            ui.table(
              res.items.map((n) => ({
                number: n.phoneNumber,
                locality: n.locality ?? "—",
                region: n.region ?? "—",
                capabilities: caps(n.capabilities),
                monthly: price(n.pricing?.monthlyPrice),
                upfront: price(n.pricing?.upfrontPrice),
              }))
            )
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("requirements")
        .description("Regulatory requirements for a country/type.")
        .requiredOption("--country <iso>", "Two-letter ISO country code")
        .option("--type <type>", "local | mobile | tollFree")
        .action(async (opts) => {
          const api = await apiFactory()
          try {
            const res = await api.get("/v1/phone-numbers/requirements", {
              countryCode: opts.country,
              type: opts.type,
            })
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("buy <phoneNumber>")
        .description("Purchase a number in E.164 format.")
        .option("--name <name>", "Custom name for the number")
        .action(async (number, opts) => {
          const api = await apiFactory()
          try {
            const res = await api.post("/v1/phone-numbers", {
              phoneNumber: number,
              ...(opts.name ? { name: opts.name } : {}),
            })
            ui.success("Purchased.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("update <phoneNumberId>")
        .description("Rename or assign/unassign to a sender.")
        .option("--name <name>", "Custom name (use empty string to clear)")
        .option("--sender <senderId>", "Assign to sender (use 'null' to unassign)")
        .action(async (id, opts) => {
          const body: Record<string, unknown> = {}
          if (opts.name !== undefined) body.name = opts.name
          if (opts.sender !== undefined) body.senderId = opts.sender === "null" ? null : opts.sender
          const api = await apiFactory()
          try {
            const res = await api.patch(`/v1/phone-numbers/${id}`, body)
            ui.success("Updated.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })
    },
  })
