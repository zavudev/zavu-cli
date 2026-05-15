// `zavu messages …` — thin wrappers over the SDK's messages resource.
// Each subcommand maps 1:1 to a method on `client.messages`. Adding new
// endpoints is trivial: import the SDK type, add a Commander subcommand,
// pass-through the args.

import { Command } from "commander"
import { buildClient } from "../../lib/client"
import { ui, fail } from "../../lib/ui"

export function messagesCommand(): Command {
  const cmd = new Command("messages").description("Send and inspect messages.")

  cmd
    .command("send")
    .description("Send a message via SMS, WhatsApp, Telegram, or Email.")
    .requiredOption("--to <recipient>", "Phone (E.164), email, or chat ID")
    .option("--text <text>", "Message body")
    .option(
      "--channel <channel>",
      "auto | sms | whatsapp | telegram | email | voice",
      "auto"
    )
    .option("--sender <senderId>", "Sender ID (defaults to project default)")
    .option("--subject <subject>", "Email subject (required for email)")
    .option("--html <html>", "HTML body (email only)")
    .option("--json", "Print full response as JSON")
    .action(async (opts) => {
      const client = await buildClient()
      try {
        const message = await client.messages.send({
          to: opts.to,
          text: opts.text,
          channel: opts.channel,
          subject: opts.subject,
          htmlBody: opts.html,
          ...(opts.sender ? { "Zavu-Sender": opts.sender } : {}),
        })
        if (opts.json) {
          process.stdout.write(JSON.stringify(message, null, 2) + "\n")
          return
        }
        ui.success(`Sent: ${message.message.id}`)
        ui.hint(`status: ${message.message.status}`)
        ui.hint(`channel: ${message.message.channel}`)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("list")
    .description("List recent messages.")
    .option("--limit <n>", "Page size", "20")
    .option("--status <status>", "Filter by status")
    .option("--channel <channel>", "Filter by channel")
    .option("--to <recipient>", "Filter by recipient")
    .option("--json", "Print as JSON")
    .action(async (opts) => {
      const client = await buildClient()
      const messages: Array<{
        id: string
        to: string
        channel: string
        status: string
        createdAt: string
      }> = []
      try {
        const page = client.messages.list({
          limit: Number(opts.limit),
          ...(opts.status ? { status: opts.status } : {}),
          ...(opts.channel ? { channel: opts.channel } : {}),
          ...(opts.to ? { to: opts.to } : {}),
        })
        for await (const m of page) {
          messages.push({
            id: m.id,
            to: m.to,
            channel: m.channel,
            status: m.status,
            createdAt: new Date(m.createdAt).toISOString(),
          })
          if (messages.length >= Number(opts.limit)) break
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(messages, null, 2) + "\n")
        return
      }
      if (messages.length === 0) {
        ui.info("No messages found.")
        return
      }
      ui.table(messages)
    })

  cmd
    .command("get <messageId>")
    .description("Retrieve a message by ID.")
    .option("--json", "Print as JSON")
    .action(async (messageId: string, opts: { json?: boolean }) => {
      const client = await buildClient()
      try {
        const res = await client.messages.retrieve(messageId)
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        const m = res.message
        ui.info(`${m.id}  →  ${m.to}`)
        ui.hint(`channel: ${m.channel}`)
        ui.hint(`status:  ${m.status}`)
        ui.hint(`text:    ${m.text ?? "(none)"}`)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  return cmd
}
