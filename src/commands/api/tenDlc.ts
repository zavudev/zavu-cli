// 10DLC group: brands + campaigns. Both share the same draft → submit → sync
// lifecycle, so they're co-located here.

import { Command } from "commander"
import { buildApi } from "../../lib/api"
import { loadJsonBody } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

function brandsSub(parent: Command) {
  const cmd = parent.command("brands").description("10DLC brand registrations.")
  cmd
    .command("list")
    .option("--limit <n>", "Page size", "20")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: any[] }>("/v1/10dlc/brands", { limit: opts.limit })
        if (!res.items?.length) return ui.info("No brands.")
        ui.table(
          res.items.map((b) => ({
            id: b.id,
            name: b.displayName,
            country: b.country,
            status: b.status,
            score: b.brandScore != null ? String(b.brandScore) : "—",
          }))
        )
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
  cmd.command("get <brandId>").action(async (id) => {
    const api = await buildApi()
    try {
      process.stdout.write(JSON.stringify(await api.get(`/v1/10dlc/brands/${id}`), null, 2) + "\n")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })
  cmd
    .command("create")
    .description("Create a draft brand. Body must match TenDlcBrandCreateRequest.")
    .option("--data <json>", "Inline JSON body")
    .option("--file <path>", "Path to a JSON file")
    .action(async (opts) => {
      const body = await loadJsonBody(opts)
      const api = await buildApi()
      try {
        const res = await api.post("/v1/10dlc/brands", body)
        ui.success("Brand draft created.")
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
  cmd.command("submit <brandId>").action(async (id) => {
    const api = await buildApi()
    try {
      const res = await api.post(`/v1/10dlc/brands/${id}/submit`)
      ui.success("Submitted to TCR.")
      process.stdout.write(JSON.stringify(res, null, 2) + "\n")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })
  cmd.command("sync <brandId>").action(async (id) => {
    const api = await buildApi()
    try {
      const res = await api.post(`/v1/10dlc/brands/${id}/sync`)
      process.stdout.write(JSON.stringify(res, null, 2) + "\n")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })
  cmd.command("delete <brandId>").action(async (id) => {
    const api = await buildApi()
    try {
      await api.del(`/v1/10dlc/brands/${id}`)
      ui.success("Deleted.")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })
  cmd
    .command("use-cases")
    .description("List available campaign use cases.")
    .action(async () => {
      const api = await buildApi()
      try {
        process.stdout.write(
          JSON.stringify(await api.get("/v1/10dlc/brands/use-cases"), null, 2) + "\n"
        )
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}

function campaignsSub(parent: Command) {
  const cmd = parent.command("campaigns").description("10DLC campaign registrations.")
  cmd
    .command("list")
    .option("--brand <brandId>", "Filter by brand")
    .option("--limit <n>", "Page size", "20")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: any[] }>("/v1/10dlc/campaigns", {
          brandId: opts.brand,
          limit: opts.limit,
        })
        if (!res.items?.length) return ui.info("No campaigns.")
        ui.table(
          res.items.map((c) => ({
            id: c.id,
            name: c.name,
            useCase: c.useCase,
            status: c.status,
            limit: c.dailyLimit ?? "—",
          }))
        )
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
  cmd
    .command("create")
    .option("--data <json>", "Inline JSON body")
    .option("--file <path>", "Path to a JSON file")
    .action(async (opts) => {
      const body = await loadJsonBody(opts)
      const api = await buildApi()
      try {
        const res = await api.post("/v1/10dlc/campaigns", body)
        ui.success("Campaign draft created.")
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
  cmd.command("submit <campaignId>").action(async (id) => {
    const api = await buildApi()
    try {
      const res = await api.post(`/v1/10dlc/campaigns/${id}/submit`)
      ui.success("Submitted.")
      process.stdout.write(JSON.stringify(res, null, 2) + "\n")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })
  cmd.command("sync <campaignId>").action(async (id) => {
    const api = await buildApi()
    try {
      const res = await api.post(`/v1/10dlc/campaigns/${id}/sync`)
      process.stdout.write(JSON.stringify(res, null, 2) + "\n")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })
  cmd.command("delete <campaignId>").action(async (id) => {
    const api = await buildApi()
    try {
      await api.del(`/v1/10dlc/campaigns/${id}`)
      ui.success("Deleted.")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })
  cmd
    .command("assign <campaignId> <phoneNumberId>")
    .description("Assign a phone number to an approved campaign.")
    .action(async (cid, pnid) => {
      const api = await buildApi()
      try {
        const res = await api.post(`/v1/10dlc/campaigns/${cid}/phone-numbers`, {
          phoneNumberId: pnid,
        })
        ui.success("Assigned.")
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
  cmd
    .command("unassign <campaignId> <assignmentId>")
    .description("Remove a phone number assignment.")
    .action(async (cid, aid) => {
      const api = await buildApi()
      try {
        await api.del(`/v1/10dlc/campaigns/${cid}/phone-numbers/${aid}`)
        ui.success("Unassigned.")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}

export function tenDlcCommand(): Command {
  const cmd = new Command("10dlc").description(
    "10DLC compliance: brands, campaigns, phone-number assignments."
  )
  brandsSub(cmd)
  campaignsSub(cmd)
  return cmd
}
