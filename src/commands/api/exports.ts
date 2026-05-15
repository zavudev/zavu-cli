import { Command } from "commander"
import { defineResource } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

export const exportsCommand = (): Command =>
  defineResource({
    name: "exports",
    description: "Asynchronous data exports (messages, conversations, logs).",
    basePath: "/v1/exports",
    itemKey: "export",
    idArg: "exportId",
    format: (e) => ({
      id: e.id,
      status: e.status,
      types: Array.isArray(e.dataTypes) ? e.dataTypes.join(",") : "—",
      expires: e.expiresAt ?? "—",
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("create")
        .description("Queue a new export job.")
        .requiredOption(
          "--types <list>",
          "Comma-separated: messages,conversations,webhookDeliveries,agentExecutions,activities"
        )
        .option("--from <iso>", "Start date (ISO timestamp)")
        .option("--to <iso>", "End date (ISO timestamp)")
        .action(async (opts) => {
          const api = await apiFactory()
          try {
            const body: Record<string, unknown> = {
              dataTypes: opts.types.split(",").map((s: string) => s.trim()).filter(Boolean),
            }
            if (opts.from) body.dateFrom = opts.from
            if (opts.to) body.dateTo = opts.to
            const res = await api.post("/v1/exports", body)
            ui.success("Export queued.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })
    },
  })
