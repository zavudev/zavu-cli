import { Command } from "commander"
import { defineResource } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

export const invitationsCommand = (): Command =>
  defineResource({
    name: "invitations",
    description: "Partner invitation links (white-label WhatsApp onboarding).",
    basePath: "/v1/invitations",
    itemKey: "invitation",
    idArg: "invitationId",
    create: true,
    format: (i) => ({
      id: i.id,
      client: i.clientName ?? "—",
      status: i.status,
      expires: i.expiresAt ?? "—",
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("cancel <invitationId>")
        .description("Cancel an active invitation.")
        .action(async (id) => {
          const api = await apiFactory()
          try {
            const res = await api.post(`/v1/invitations/${id}/cancel`)
            ui.success("Cancelled.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })
    },
  })
