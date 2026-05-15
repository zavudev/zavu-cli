import { Command } from "commander"
import { defineResource, loadJsonBody } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

export const broadcastsCommand = (): Command =>
  defineResource({
    name: "broadcasts",
    description: "Bulk message campaigns across SMS, WhatsApp, Email, etc.",
    basePath: "/v1/broadcasts",
    itemKey: "broadcast",
    idArg: "broadcastId",
    create: true,
    remove: true,
    format: (b) => ({
      id: b.id,
      name: b.name,
      channel: b.channel,
      status: b.status,
      total: String(b.totalContacts ?? 0),
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("add-contacts <broadcastId>")
        .description("Add contacts in bulk (--file <path> with {contacts:[…]}).")
        .option("--file <path>", "Path to a JSON file")
        .option("--data <json>", "Inline JSON body")
        .action(async (id, opts) => {
          const body = await loadJsonBody(opts)
          const api = await apiFactory()
          try {
            const res = await api.post(`/v1/broadcasts/${id}/contacts`, body)
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("send <broadcastId>")
        .description("Start sending the broadcast (or schedule with --at).")
        .option("--at <iso>", "Schedule for ISO timestamp instead of now")
        .action(async (id, opts) => {
          const api = await apiFactory()
          try {
            const body = opts.at ? { scheduledAt: opts.at } : {}
            const res = await api.post(`/v1/broadcasts/${id}/send`, body)
            ui.success(opts.at ? "Scheduled." : "Sending.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("cancel <broadcastId>")
        .description("Cancel a broadcast.")
        .action(async (id) => {
          const api = await apiFactory()
          try {
            const res = await api.post(`/v1/broadcasts/${id}/cancel`)
            ui.success("Cancelled.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("progress <broadcastId>")
        .description("Show real-time delivery progress.")
        .action(async (id) => {
          const api = await apiFactory()
          try {
            const res = await api.get(`/v1/broadcasts/${id}/progress`)
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })
    },
  })
