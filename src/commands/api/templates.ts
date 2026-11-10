import { Command } from "commander"
import { defineResource } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

export const templatesCommand = (): Command =>
  defineResource({
    name: "templates",
    description: "WhatsApp message templates.",
    basePath: "/v1/templates",
    idArg: "templateId",
    create: true,
    remove: true,
    format: (t) => ({
      id: t.id,
      name: t.name,
      lang: t.language ?? "—",
      category: t.category ?? "—",
      status: t.status ?? "—",
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("submit <templateId>")
        .description("Submit a template to Meta for approval.")
        .requiredOption("--sender <senderId>", "Sender with the WABA")
        .option("--category <category>", "UTILITY | MARKETING | AUTHENTICATION")
        .action(async (id, opts) => {
          const api = await apiFactory()
          try {
            const body: Record<string, unknown> = { senderId: opts.sender }
            if (opts.category) body.category = opts.category
            const res = await api.post(`/v1/templates/${id}/submit`, body)
            ui.success("Submitted for approval.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })
    },
  })
