import { Command } from "commander"
import { defineResource } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

export const documentsCommand = (): Command =>
  defineResource({
    name: "documents",
    description: "Regulatory documents for phone number compliance.",
    basePath: "/v1/documents",
    itemKey: "document",
    idArg: "documentId",
    remove: true,
    format: (d) => ({
      id: d.id,
      name: d.name,
      type: d.documentType,
      status: d.status,
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("upload-url")
        .description("Get a presigned URL for uploading a document file.")
        .action(async () => {
          const api = await apiFactory()
          try {
            const res = await api.post<{ uploadUrl: string }>("/v1/documents/upload-url")
            ui.success("Upload URL ready.")
            process.stdout.write(`${res.uploadUrl}\n`)
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })
    },
  })
