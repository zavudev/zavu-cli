// `zavu email-domains` — add an email sending domain, get the DNS records to
// publish, verify them, and remove it. Once a domain is verified you can create
// an email sender on it: `zavu senders create --email noreply@yourdomain.com`.
//
// Publishing the DNS records is the one step that happens at your DNS provider
// (that's outside Zavu); everything else is here.

import { Command } from "commander"
import { buildApi } from "../../lib/api"
import { ui, fail, cli } from "../../lib/ui"

interface DnsRecord {
  type: string
  name: string
  value: string
  priority?: number
  purpose: string
  required: boolean
}
interface Domain {
  id: string
  domain: string
  status: string
  dkimStatus: string
  dnsRecords?: DnsRecord[]
}

function printRecords(records: DnsRecord[] | undefined) {
  if (!records?.length) {
    ui.info(`No DNS records yet — run \`${cli("email-domains get <id>")}\` in a moment.`)
    return
  }
  ui.info("\nAdd these records at your DNS provider:")
  ui.table(
    records.map((r) => ({
      required: r.required ? "yes" : "—",
      type: r.type,
      name: r.name,
      value: r.value + (r.priority !== undefined ? ` (priority ${r.priority})` : ""),
    }))
  )
  ui.hint(`\nThen verify: ${cli("email-domains verify <id>")}`)
}

export function emailDomainsCommand(): Command {
  const cmd = new Command("email-domains").description(
    "Add and verify email sending domains."
  )

  cmd
    .command("add <domain>")
    .description("Add a domain (e.g. example.com) and print its DNS records.")
    .option("--json", "Print the raw response")
    .action(async (domain: string, opts: { json?: boolean }) => {
      const api = await buildApi()
      try {
        const res = await api.post<{ domain: Domain }>("/v1/email-domains", { domain })
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        ui.success(`Added ${res.domain.domain} (${res.domain.id}) · status: ${res.domain.status}`)
        printRecords(res.domain.dnsRecords)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("list")
    .description("List email domains and their status.")
    .option("--json", "Print as JSON")
    .action(async (opts: { json?: boolean }) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: Domain[] }>("/v1/email-domains")
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.items, null, 2) + "\n")
          return
        }
        if (!res.items?.length) {
          ui.info(`No email domains. Add one: ${cli("email-domains add <domain>")}`)
          return
        }
        ui.table(
          res.items.map((d) => ({
            id: d.id,
            domain: d.domain,
            status: d.status,
            dkim: d.dkimStatus,
          }))
        )
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("get <domainId>")
    .description("Show a domain with its DNS records.")
    .option("--json", "Print as JSON")
    .action(async (domainId: string, opts: { json?: boolean }) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ domain: Domain }>(`/v1/email-domains/${domainId}`)
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.domain, null, 2) + "\n")
          return
        }
        ui.info(`${res.domain.domain} · status: ${res.domain.status} · dkim: ${res.domain.dkimStatus}`)
        printRecords(res.domain.dnsRecords)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("verify <domainId>")
    .description("Re-check the domain's DNS records.")
    .action(async (domainId: string) => {
      const api = await buildApi()
      try {
        const res = await api.post<{ domain: Domain }>(`/v1/email-domains/${domainId}/verify`)
        ui.success(`Status: ${res.domain.status} · dkim: ${res.domain.dkimStatus}`)
        if (res.domain.status !== "verified") {
          ui.hint("Not verified yet. DNS can take a while to propagate; run verify again shortly.")
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("rm <domainId>")
    .description("Remove an email domain.")
    .action(async (domainId: string) => {
      const api = await buildApi()
      try {
        await api.del(`/v1/email-domains/${domainId}`)
        ui.success("Domain removed.")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  return cmd
}
