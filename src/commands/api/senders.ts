import { Command } from "commander"
import { defineResource, loadJsonBody } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

// Build a sender create body from friendly flags. A sender needs a name plus at
// least one channel identifier: a phone number (SMS/WhatsApp/voice) or an email
// address (email channel). Advanced fields still go through --data/--file.
function buildSenderBody(opts: Record<string, any>): Record<string, unknown> {
  if (!opts.name) fail("`--name` is required (or pass --data/--file with full JSON).")
  if (!opts.phone && !opts.email) {
    fail("Provide --phone <E.164> and/or --email <address> (or --data/--file).")
  }
  const body: Record<string, unknown> = { name: opts.name }
  if (opts.phone) body.phoneNumber = opts.phone
  if (opts.email) body.emailAddress = opts.email
  if (opts.emailFromName) body.emailFromName = opts.emailFromName
  if (opts.enableVoice) {
    if (!opts.phone) fail("`--enable-voice` needs `--phone`: a sender with no number cannot take calls.")
    body.enableVoice = true
  }
  if (opts.setDefault) body.setAsDefault = true
  if (opts.webhookUrl) body.webhookUrl = opts.webhookUrl
  if (opts.webhookEvents) {
    body.webhookEvents = String(opts.webhookEvents)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return body
}

/** Update body from flags. Voice used to be reachable only from the dashboard. */
function buildSenderUpdateBody(opts: Record<string, any>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (opts.name) body.name = opts.name
  if (opts.enableVoice) body.enableVoice = true
  if (opts.disableVoice) body.enableVoice = false
  if (opts.setDefault) body.setAsDefault = true
  if (Object.keys(body).length === 0) {
    fail("Nothing to update. Pass --name, --enable-voice, --disable-voice, --set-default, or --data/--file.")
  }
  return body
}

export const sendersCommand = (): Command =>
  defineResource({
    name: "senders",
    description: "Manage sender profiles (phone numbers, WhatsApp, email).",
    basePath: "/v1/senders",
    itemKey: "sender",
    idArg: "senderId",
    // `create` is defined below with friendly flags instead of the generic
    // JSON-only one.
    create: false,
    remove: true,
    format: (s) => ({
      id: s.id,
      name: s.name,
      phone: s.phoneNumber ?? "—",
      email: s.emailAddress ?? "—",
      default: s.isDefault ? "yes" : "",
      whatsapp: s.whatsapp ? "yes" : "",
    }),
    customize: (cmd, apiFactory) => {
      cmd
        .command("create")
        .description("Create a sender. Use --name + --phone and/or --email, or --data/--file.")
        .option("--name <name>", "Display name")
        .option("--phone <e164>", "A number this project owns, in E.164. Routed to the sender so its channels work.")
        .option("--enable-voice", "Let this sender place and answer calls. Requires --phone.")
        .option("--email <address>", "From-address for the email channel (domain must be verified)")
        .option("--email-from-name <name>", "Display name shown in the recipient's inbox")
        .option("--set-default", "Make this the project's default sender")
        .option("--webhook-url <url>", "HTTPS URL for webhook events")
        .option("--webhook-events <list>", "Comma-separated events to subscribe to")
        .option("--data <json>", "Full JSON body (advanced)")
        .option("--file <path>", "Path to a JSON body file (advanced)")
        .action(async (opts) => {
          const body = opts.data || opts.file ? await loadJsonBody(opts) : buildSenderBody(opts)
          const api = await apiFactory()
          try {
            const res = await api.post<{ sender?: any }>("/v1/senders", body)
            const sender = res.sender ?? res
            ui.success(`Created sender ${sender?.id ?? "(no id)"}`)
            process.stdout.write(JSON.stringify(sender, null, 2) + "\n")
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
        })

      cmd
        .command("update <senderId>")
        .description("Update a sender. Use --name / --enable-voice / --disable-voice, or --data/--file.")
        .option("--name <name>", "Rename the sender")
        .option("--enable-voice", "Let this sender place and answer calls")
        .option("--disable-voice", "Stop this sender taking calls")
        .option("--set-default", "Make this the project's default sender")
        .option("--data <json>", "Inline JSON body")
        .option("--file <path>", "Path to a JSON file")
        .action(async (id, opts) => {
          if (opts.enableVoice && opts.disableVoice) {
            fail("Pass either --enable-voice or --disable-voice, not both.")
          }
          const body =
            opts.data || opts.file ? await loadJsonBody(opts) : buildSenderUpdateBody(opts)
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
