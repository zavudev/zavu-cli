import { Command } from "commander"
import { defineResource, loadJsonBody } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

export const subAccountsCommand = (): Command =>
  defineResource({
    name: "sub-accounts",
    description: "Manage sub-accounts (white-label projects). Parent key only.",
    basePath: "/v1/sub-accounts",
    itemKey: "subAccount",
    idArg: "id",
    create: true,
    remove: true,
    format: (s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      spent: s.totalSpent != null ? `$${(s.totalSpent / 100).toFixed(2)}` : "—",
      cap: s.creditLimit != null ? `$${(s.creditLimit / 100).toFixed(2)}` : "—",
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("update <id>")
        .description("Update a sub-account.")
        .option("--data <json>", "Inline JSON body")
        .option("--file <path>", "Path to a JSON file")
        .action(async (id, opts) => {
          const body = await loadJsonBody(opts)
          const api = await apiFactory()
          try {
            const res = await api.patch(`/v1/sub-accounts/${id}`, body)
            ui.success("Updated.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("balance <id>")
        .description("Show a sub-account's spending.")
        .action(async (id) => {
          const api = await apiFactory()
          try {
            const res = await api.get(`/v1/sub-accounts/${id}/balance`)
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("api-keys <id>")
        .description("List a sub-account's API keys.")
        .action(async (id) => {
          const api = await apiFactory()
          try {
            const res = await api.get(`/v1/sub-accounts/${id}/api-keys`)
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("create-api-key <id>")
        .description("Mint a new API key for a sub-account (returned once).")
        .requiredOption("--name <name>", "Display name")
        .option("--env <env>", "live | test", "live")
        .action(async (id, opts) => {
          const api = await apiFactory()
          try {
            const res = await api.post(`/v1/sub-accounts/${id}/api-keys`, {
              name: opts.name,
              environment: opts.env,
            })
            ui.success("API key created — save it now, it won't be shown again.")
            process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("revoke-api-key <id> <keyId>")
        .description("Revoke a sub-account API key.")
        .action(async (id, keyId) => {
          const api = await apiFactory()
          try {
            await api.del(`/v1/sub-accounts/${id}/api-keys/${keyId}`)
            ui.success("Revoked.")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })
    },
  })
