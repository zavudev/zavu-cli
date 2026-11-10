// `npx zavudev telegram` — connect or disconnect a Telegram bot on a sender, fully
// from the CLI. You still create the bot in Telegram with @BotFather (that's a
// Telegram step); paste its token here and Zavu validates it, registers the
// webhook, and routes the sender's Telegram traffic through it.

import { Command } from "commander"
import { buildApi } from "../../lib/api"
import { ui, fail } from "../../lib/ui"

export function telegramCommand(): Command {
  const cmd = new Command("telegram").description("Connect a Telegram bot to a sender.")

  cmd
    .command("connect")
    .description("Connect a Telegram bot (token from @BotFather) to a sender.")
    .requiredOption("--sender <senderId>", "Sender to attach the bot to")
    .requiredOption("--token <botToken>", "Bot token from @BotFather")
    .action(async (opts: { sender: string; token: string }) => {
      const api = await buildApi()
      try {
        const res = await api.post<{
          telegram: { connected: boolean; botUsername?: string; botId?: string }
        }>(`/v1/senders/${opts.sender}/telegram`, { botToken: opts.token })
        const t = res.telegram
        ui.success(
          `Telegram connected${t.botUsername ? ` as @${t.botUsername}` : ""}. ` +
            `Messages to the bot now reach this sender.`
        )
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("disconnect")
    .description("Disconnect Telegram from a sender (removes the webhook).")
    .requiredOption("--sender <senderId>", "Sender to detach Telegram from")
    .action(async (opts: { sender: string }) => {
      const api = await buildApi()
      try {
        await api.del(`/v1/senders/${opts.sender}/telegram`)
        ui.success("Telegram disconnected.")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  return cmd
}
