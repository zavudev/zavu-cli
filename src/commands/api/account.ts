// Read-only "where am I" group: balance, plan, usage, phone introspection.
// These are singleton endpoints that don't fit the resource list/get pattern.

import { Command } from "commander"
import { buildApi } from "../../lib/api"
import { ui, fail } from "../../lib/ui"

export function balanceCommand(): Command {
  return new Command("balance")
    .description("Show team balance and (if applicable) sub-account spending.")
    .option("--json", "Print as JSON")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<any>("/v1/balance")
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        ui.info(`Balance: $${(res.balance / 100).toFixed(2)} ${res.currency.toUpperCase()}`)
        if (res.isSubAccount) {
          ui.hint(`Spent: $${((res.totalSpent ?? 0) / 100).toFixed(2)}`)
          if (res.creditLimit) {
            ui.hint(`Cap: $${(res.creditLimit / 100).toFixed(2)}`)
          }
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}

export function planCommand(): Command {
  return new Command("plan")
    .description("Show the current subscription plan.")
    .option("--json", "Print as JSON")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<any>("/v1/plan")
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        ui.info(`Tier:    ${res.tier}`)
        ui.hint(`Billing:  ${res.billingInterval}`)
        ui.hint(`Status:   ${res.status}`)
        if (res.currentPeriodEnd) ui.hint(`Renews:   ${res.currentPeriodEnd}`)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}

export function usageCommand(): Command {
  return new Command("usage")
    .description("Show this month's A2P + email usage against the plan limits.")
    .option("--json", "Print as JSON")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<any>("/v1/usage")
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        ui.info(`Month:    ${res.monthKey}  (tier: ${res.tier})`)
        ui.hint(`A2P:      ${res.messagesA2P} / ${res.limits?.messagesA2P ?? "∞"}`)
        ui.hint(`Email:    ${res.emailsSent} / ${res.limits?.emails ?? "∞"}`)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}

export function introspectCommand(): Command {
  const cmd = new Command("introspect").description("Inspect phone numbers, etc.")
  cmd
    .command("phone <e164>")
    .description("Validate a phone number, get carrier + line type.")
    .action(async (phone) => {
      const api = await buildApi()
      try {
        const res = await api.post("/v1/introspect/phone", { phoneNumber: phone })
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
  return cmd
}
