import { Command } from "commander"
import { defineResource } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

export const urlsCommand = (): Command =>
  defineResource({
    name: "urls",
    description: "URL verification (required for SMS/email links).",
    basePath: "/v1/urls",
    itemKey: "url",
    idArg: "urlId",
    format: (u) => ({
      id: u.id,
      url: u.url,
      domain: u.domain,
      status: u.status,
      via: u.approvalType ?? "—",
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("submit <url>")
        .description("Submit a URL for verification (auto-approves safe URLs).")
        .action(async (url) => {
          const api = await apiFactory()
          try {
            const res = await api.post("/v1/urls", { url })
            ui.success("Submitted.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })
    },
  })
