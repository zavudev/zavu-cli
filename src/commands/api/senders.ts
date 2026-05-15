import { Command } from "commander"
import { defineResource, loadJsonBody } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

export const sendersCommand = (): Command =>
  defineResource({
    name: "senders",
    description: "Manage sender profiles (phone numbers, WhatsApp, email).",
    basePath: "/v1/senders",
    itemKey: "sender",
    idArg: "senderId",
    create: true,
    remove: true,
    format: (s) => ({
      id: s.id,
      name: s.name,
      phone: s.phoneNumber ?? "—",
      default: s.isDefault ? "yes" : "",
      whatsapp: s.whatsapp ? "yes" : "",
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("update <senderId>")
        .description("Update a sender (--data '{...}' or --file <path>).")
        .option("--data <json>", "Inline JSON body")
        .option("--file <path>", "Path to a JSON file")
        .action(async (id, opts) => {
          const body = await loadJsonBody(opts)
          const api = await apiFactory()
          try {
            const res = await api.patch(`/v1/senders/${id}`, body)
            ui.success("Updated.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("rotate-secret <senderId>")
        .description("Regenerate the webhook signing secret. Old secret stops working.")
        .action(async (id) => {
          const api = await apiFactory()
          try {
            const res = await api.post<{ secret: string }>(
              `/v1/senders/${id}/webhook/secret`
            )
            ui.success("New secret generated. Save it — it won't be shown again.")
            process.stdout.write(`${res.secret}\n`)
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })
    },
  })
