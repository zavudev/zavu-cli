import { Command } from "commander"
import { defineResource, loadJsonBody } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

export const contactsCommand = (): Command =>
  defineResource({
    name: "contacts",
    description: "Manage contacts and their communication channels.",
    basePath: "/v1/contacts",
    idArg: "contactId",
    create: true,
    remove: true,
    format: (c) => ({
      id: c.id,
      name: c.displayName ?? "—",
      phone: c.primaryPhone ?? c.phoneNumber ?? "—",
      email: c.primaryEmail ?? "—",
      channels: Array.isArray(c.availableChannels) ? c.availableChannels.join(",") : "—",
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("by-phone <e164>")
        .description("Look up a contact by phone number.")
        .action(async (phone) => {
          const api = await apiFactory()
          try {
            const res = await api.get(`/v1/contacts/phone/${encodeURIComponent(phone)}`)
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("add-channel <contactId>")
        .description("Add a new channel (--data '{channel,identifier,...}').")
        .option("--data <json>", "Inline JSON body")
        .option("--file <path>", "Path to a JSON file")
        .action(async (id, opts) => {
          const body = await loadJsonBody(opts)
          const api = await apiFactory()
          try {
            const res = await api.post(`/v1/contacts/${id}/channels`, body)
            ui.success("Channel added.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("remove-channel <contactId> <channelId>")
        .description("Remove a channel from a contact.")
        .action(async (cid, chid) => {
          const api = await apiFactory()
          try {
            await api.del(`/v1/contacts/${cid}/channels/${chid}`)
            ui.success("Channel removed.")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("merge <targetContactId> <sourceContactId>")
        .description("Merge sourceContact into targetContact.")
        .action(async (target, source) => {
          const api = await apiFactory()
          try {
            const res = await api.post(`/v1/contacts/${target}/merge`, {
              sourceContactId: source,
            })
            ui.success("Merged.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })
    },
  })
