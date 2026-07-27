// Factory agents — `zavu agents catalog` and `zavu agents pull <id>`.
//
// These mirror the Functions quickstart flow for voice/text agents: pull a
// ready-made agent into your codebase, then `zavu deploy`. The catalog and the
// rendered function files come from the API (`/v1/agent-templates`), so the CLI
// never hard-codes an agent body — new factory agents ship server-side.
//
//   zavu agents catalog            # list the factory agents
//   zavu agents pull fermi         # scaffold ./fermi and register it
//   zavu agents pull fermi --sender sndr_… --dir agents/fermi
//   cd fermi && zavu deploy        # ship it

import { Command } from "commander"
import prompts from "prompts"
import { mkdir, writeFile, access } from "node:fs/promises"
import { join, basename, resolve } from "node:path"
import { buildApi, ApiClient } from "../../lib/api"
import { buildClient } from "../../lib/client"
import { writeProjectConfig } from "../../lib/config"
import { ui, fail, cli } from "../../lib/ui"
import { writeTsconfig, RUNTIME_DEV_DEPENDENCY, SCAFFOLD_GITIGNORE } from "../../lib/scaffold"

interface CatalogItem {
  id: string
  name: string
  summary: string
  category: string
  voice: boolean
  toolCount: number
}

interface RenderedTemplate {
  id: string
  name: string
  summary: string
  category: string
  voice: boolean
  defaultSlug: string
  files: Array<{ path: string; content: string }>
  dependencies: Record<string, string>
  requiredSecrets: Array<{ key: string; hint: string }>
}

// Attaches `catalog` + `pull` to the existing `agents` command group.
export function attachFactoryCommands(parent: Command): void {
  parent
    .command("catalog")
    .description("List the factory agents you can pull into your project.")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: CatalogItem[] }>("/v1/agent-templates")
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.items, null, 2) + "\n")
          return
        }
        if (!res.items?.length) {
          ui.info("No factory agents available.")
          return
        }
        ui.table(
          res.items.map((t) => ({
            id: t.id,
            name: t.name,
            voice: t.voice ? "yes" : "—",
            tools: String(t.toolCount),
            category: t.category,
          }))
        )
        ui.hint(`\nPull one with:  ${cli("agents pull <id>")}`)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  parent
    .command("pull <id>")
    .description(
      "Scaffold a factory agent into your codebase and register it. Then `cd` in and `zavu deploy`."
    )
    .option("--dir <path>", "Directory to scaffold into (defaults to ./<id>)")
    .option(
      "--sender <senderId>",
      "Sender the agent runs on. Sets the SENDER_ID secret automatically."
    )
    // Without this a booking agent ships handlers pointing at a webhook you
    // have to build and host, so it cannot book until you do.
    .option(
      "--calendar <provider>",
      "For booking agents: webhook (default) or calcom for a working Cal.com client"
    )
    .action(
      async (id: string, opts: { dir?: string; sender?: string; calendar?: string }) => {
      const api = await buildApi()

      const { targetDir, template, senderSet } = await scaffoldTemplate(
        api,
        id,
        opts.dir,
        opts.sender,
        opts.calendar
      )

      await ui.scrambleSuccess(`Pulled "${template.name}".`)

      // 6. Next steps — mirror the Functions quickstart.
      ui.info("\nNext steps:")
      ui.hint(`cd ${basename(targetDir)}`)
      // Deploy works without this, so it is tempting to leave out. But every
      // local verification step — `fn invoke`, `tsc --noEmit`, the editor — is
      // dead until the devDependencies are installed, and the failure reads as
      // "the tool is broken" rather than "you skipped a step".
      ui.hint("npm install                          # required for fn invoke + tsc")
      if (!senderSet) {
        ui.hint(`${cli("senders list")}                    # find your sender id`)
        ui.hint(cli("fn secrets set SENDER_ID <senderId>"))
      }
      // The API returns every secret the agent needs, with a hint for each. Only
      // SENDER_ID was ever set or mentioned, so you could follow these steps to
      // the letter and end up with a booking agent that can never book — the
      // first symptom arriving mid-call.
      for (const secret of template.requiredSecrets ?? []) {
        if (secret.key === "SENDER_ID") continue
        ui.hint(`${cli(`fn secrets set ${secret.key} <value>`)}`)
        ui.hint(`  ↳ ${secret.hint}`)
      }
      ui.hint(cli("deploy"))
      if (template.voice) {
        ui.hint("# then call the sender's number — the agent answers")
      }
    })

  // `zavu agents init` — the one-command guided setup. Picks (or creates) a
  // sender, pulls a factory agent, and leaves you ready to `zavu deploy`.
  parent
    .command("init")
    .description("Guided setup: choose or create a sender, pull a factory agent, get ready to deploy.")
    .option("--template <id>", "Factory agent id (skip the prompt)")
    .option("--sender <senderId>", "Use an existing sender (skip sender setup)")
    .option("--dir <path>", "Directory to scaffold into")
    .option("--buy-number", "Buy a phone number and create a sender (explicit purchase consent)")
    .option("--country <cc>", "Country to search a number in (with --buy-number)", "US")
    .option("--sender-name <name>", "Name for a newly created sender")
    .option("-y, --yes", "Accept defaults, minimal prompts")
    .action(
      async (opts: {
        template?: string
        sender?: string
        dir?: string
        buyNumber?: boolean
        country?: string
        senderName?: string
        yes?: boolean
      }) => {
        const api = await buildApi()

        // 1. Resolve the sender (existing, or a guided channel-first setup that
        // only buys a number when voice/SMS is chosen).
        const senderId = opts.sender ?? (await guidedSenderSetup(api, opts))
        if (!senderId) fail("No sender selected.")

        // 2. Pick a factory agent.
        let templateId = opts.template
        if (!templateId) {
          const { items = [] } = await api.get<{ items: CatalogItem[] }>("/v1/agent-templates")
          if (!items.length) fail("No factory agents available.")
          if (opts.yes) {
            templateId = items[0].id
          } else {
            const res = await prompts({
              type: "select",
              name: "id",
              message: "Pick a factory agent:",
              choices: items.map((t) => ({
                title: `${t.name}${t.voice ? " · voice" : ""}`,
                description: t.summary,
                value: t.id,
              })),
            })
            templateId = res.id
          }
        }
        if (!templateId) fail("No agent selected.")

        // 3. Scaffold + register + set SENDER_ID.
        const { targetDir, template } = await scaffoldTemplate(api, templateId!, opts.dir, senderId!)

        await ui.scrambleSuccess(`Ready: "${template.name}" on sender ${senderId}.`)
        ui.info("\nNext steps:")
        ui.hint(`export SENDER_ID="${senderId}"`)
        ui.hint(`cd ${basename(targetDir)}`)
        ui.hint(cli("deploy"))
        if (template.voice) ui.hint("# then call the sender's number — the agent answers")
      }
    )
}

// --- helpers ---------------------------------------------------------------

/**
 * Fetch a factory template, register it as a function, write its files, and
 * (optionally) set the SENDER_ID secret. Shared by `pull` and `init`.
 */
async function scaffoldTemplate(
  api: ApiClient,
  id: string,
  dirOpt: string | undefined,
  sender: string | undefined,
  calendar?: string
): Promise<{ targetDir: string; template: RenderedTemplate; senderSet: boolean }> {
  let template: RenderedTemplate
  try {
    const res = await api.get<{ template: RenderedTemplate }>(
      `/v1/agent-templates/${encodeURIComponent(id)}`,
      calendar ? { calendar } : undefined
    )
    template = res.template
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not.?found/i.test(msg)) {
      fail(`No factory agent "${id}". Run \`${cli("agents catalog")}\` to see the list.`)
    }
    fail(msg)
    throw err
  }

  const index = template.files.find((f) => f.path === "index.ts")
  if (!index) fail("Template is missing index.ts — cannot scaffold.")

  const initialDir = resolve(dirOpt ?? template.defaultSlug)
  if (await pathExists(initialDir)) {
    fail(`Directory ${initialDir} already exists. Pass --dir <other> or remove it first.`)
  }

  ui.step(`Registering "${template.name}" in your Zavu project…`)
  const registered = await registerFunction(api, {
    name: template.name,
    slug: template.defaultSlug,
    sourceCode: index!.content,
    dependencies: template.dependencies ?? {},
  })
  if (registered.slug !== template.defaultSlug) {
    ui.warn(`Slug "${template.defaultSlug}" was taken — used "${registered.slug}".`)
  }

  const targetDir = dirOpt ? resolve(dirOpt) : resolve(registered.slug)
  if (targetDir !== initialDir && (await pathExists(targetDir))) {
    fail(`Directory ${targetDir} already exists. Pass --dir <other> or remove it first.`)
  }
  ui.step(`Writing files to ${targetDir}…`)
  await mkdir(targetDir, { recursive: true })
  for (const file of template.files) {
    const dest = join(targetDir, file.path)
    await mkdir(join(dest, ".."), { recursive: true })
    await writeFile(dest, file.content, "utf8")
  }
  await writeFile(
    join(targetDir, "package.json"),
    JSON.stringify(
      {
        name: registered.slug,
        private: true,
        type: "module",
        dependencies: template.dependencies ?? {},
        // Provided by the runtime layer in production; declared so the editor,
        // `tsc` and `zavu fn invoke` resolve it on the developer's machine.
        devDependencies: RUNTIME_DEV_DEPENDENCY,
      },
      null,
      2
    ),
    "utf8"
  )
  await writeFile(join(targetDir, ".gitignore"), SCAFFOLD_GITIGNORE, "utf8")
  await writeTsconfig(targetDir)
  await writeProjectConfig(
    {
      projectId: registered.projectId,
      functionId: registered.functionId,
      slug: registered.slug,
      name: template.name,
    },
    targetDir
  )

  let senderSet = false
  if (sender) {
    senderSet = await setSecret(registered.functionId, "SENDER_ID", sender)
    if (senderSet) ui.success(`Set SENDER_ID = ${sender}`)
    else ui.warn("Could not set SENDER_ID automatically — set it manually below.")
  }

  return { targetDir, template, senderSet }
}

// Guided, channel-first sender setup. Offers existing senders, or sets up a new
// one — buying a phone number ONLY when voice/SMS is chosen (a number isn't
// needed for WhatsApp-by-QR, Telegram, or Email) — then connects the selected
// rich channels inline.
async function guidedSenderSetup(
  api: ApiClient,
  opts: { yes?: boolean; buyNumber?: boolean; country?: string; senderName?: string }
): Promise<string | undefined> {
  const existing = await api
    .get<{ items: Array<{ id: string; name: string; phoneNumber?: string }> }>("/v1/senders", {
      limit: 50,
    })
    .catch(() => ({ items: [] as Array<{ id: string; name: string; phoneNumber?: string }> }))
  const items = existing.items ?? []

  if (opts.yes) {
    if (opts.buyNumber) return buyNumberAndCreateSender(api, opts)
    if (items.length) return items[0].id
    return createNameOnlySender(api, opts.senderName ?? "My agent")
  }

  const pick = await prompts({
    type: "select",
    name: "sel",
    message: "Which sender should the agent run on?",
    choices: [
      ...items.map((s) => ({
        title: `${s.name}${s.phoneNumber ? ` · ${s.phoneNumber}` : ""}`,
        value: s.id,
      })),
      { title: "Set up a new sender", value: "__new__" },
    ],
  })
  if (!pick.sel) return undefined
  if (pick.sel !== "__new__") return pick.sel as string

  return newSenderGuided(api, opts)
}

async function newSenderGuided(
  api: ApiClient,
  opts: { country?: string; senderName?: string; yes?: boolean }
): Promise<string | undefined> {
  const nameRes = opts.senderName
    ? { name: opts.senderName }
    : await prompts({
        type: "text",
        name: "name",
        message: "Name this agent's sender:",
        initial: "My agent",
      })
  const name = String(nameRes.name ?? "").trim()
  if (!name) return undefined

  const chRes = await prompts({
    type: "multiselect",
    name: "channels",
    message: "How will people reach it?",
    hint: "Space to select · Enter to confirm. A phone number is only needed for voice/SMS.",
    instructions: false,
    choices: [
      { title: "Voice / SMS  (buy a phone number)", value: "phone" },
      { title: "Telegram     (bot token)", value: "telegram" },
      { title: "Email        (a domain)", value: "email" },
    ],
  })
  const channels: string[] = chRes.channels ?? []

  // The sender: with a bought number if voice/SMS is wanted, else name-only.
  const senderId = channels.includes("phone")
    ? await buyNumberAndCreateSender(api, { ...opts, senderName: name })
    : await createNameOnlySender(api, name)

  // Connect the selected rich channels inline.
  if (channels.includes("telegram")) {
    const tk = await prompts({
      type: "password",
      name: "token",
      message: "Telegram bot token (from @BotFather):",
    })
    const token = String(tk.token ?? "").trim()
    if (token) {
      try {
        const r = await api.post<{ telegram?: { botUsername?: string } }>(
          `/v1/senders/${senderId}/telegram`,
          { botToken: token }
        )
        ui.success(
          `Telegram connected${r.telegram?.botUsername ? ` as @${r.telegram.botUsername}` : ""}.`
        )
      } catch (err) {
        ui.warn(
          `Telegram connect failed: ${err instanceof Error ? err.message : String(err)}. ` +
            `Retry: ${cli(`telegram connect --sender ${senderId} --token <token>`)}`
        )
      }
    }
  }

  if (channels.includes("email")) {
    const dm = await prompts({
      type: "text",
      name: "domain",
      message: "Email domain (e.g. example.com):",
    })
    const domain = String(dm.domain ?? "").trim()
    if (domain) {
      try {
        const r = await api.post<{
          domain?: {
            id: string
            dnsRecords?: Array<{ type: string; name: string; value: string; priority?: number }>
          }
        }>("/v1/email-domains", { domain })
        ui.success(`Domain ${domain} added. Publish these DNS records, then verify:`)
        for (const rec of r.domain?.dnsRecords ?? []) {
          ui.hint(
            `${rec.type}  ${rec.name}  ${rec.value}${
              rec.priority !== undefined ? ` (priority ${rec.priority})` : ""
            }`
          )
        }
        ui.hint(`After publishing: ${cli(`email-domains verify ${r.domain?.id}`)}`)
      } catch (err) {
        ui.warn(`Email domain add failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return senderId
}

// Create a sender with just a name — channels attach afterwards. No number.
async function createNameOnlySender(api: ApiClient, name: string): Promise<string> {
  const res = await api.post<{ id?: string; sender?: { id: string } }>("/v1/senders", {
    name,
    setAsDefault: true,
  })
  const id = res.id ?? res.sender?.id
  if (!id) fail("Sender was created but the API returned no id.")
  ui.success(`Sender ${id} created.`)
  return id!
}

// Buy a phone number and create a sender for it. Purchasing spends from the
// team balance, so it is gated behind an explicit confirm (or --buy-number).
async function buyNumberAndCreateSender(
  api: ApiClient,
  opts: { yes?: boolean; country?: string; senderName?: string }
): Promise<string> {
  const country = (opts.country ?? "US").toUpperCase()
  ui.step(`Searching available numbers in ${country}…`)
  const avail = await api.get<{
    items: Array<{ phoneNumber: string; pricing?: { monthlyPrice?: number } }>
  }>("/v1/phone-numbers/available", { countryCode: country, limit: 5 })
  const number = avail.items?.[0]?.phoneNumber
  if (!number) fail(`No numbers available in ${country}.`)
  const price = avail.items?.[0]?.pricing?.monthlyPrice

  if (!opts.yes) {
    const { ok } = await prompts({
      type: "confirm",
      name: "ok",
      message: `Buy ${number}${price ? ` ($${price}/mo)` : ""}? This charges your Zavu balance.`,
      initial: true,
    })
    if (!ok) fail("Cancelled — no number purchased.")
  }

  ui.step(`Buying ${number}…`)
  await api.post("/v1/phone-numbers", { phoneNumber: number })

  const name = opts.senderName ?? "My agent"
  ui.step("Creating sender…")
  const created = await api.post<{ sender?: { id: string } }>("/v1/senders", {
    name,
    phoneNumber: number,
    setAsDefault: true,
  })
  const id = created.sender?.id
  if (!id) fail("Sender was created but the API returned no id.")
  ui.success(`Sender ${id} created with ${number}.`)
  return id!
}

const MAX_SLUG_ATTEMPTS = 25

async function registerFunction(
  api: Awaited<ReturnType<typeof buildApi>>,
  args: {
    name: string
    slug: string
    sourceCode: string
    dependencies: Record<string, string>
  }
): Promise<{ functionId: string; slug: string; projectId: string }> {
  let candidate = args.slug
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      const res = await api.post<{ function?: { id: string; slug: string } }>(
        "/v1/functions",
        {
          name: args.name,
          slug: candidate,
          sourceCode: args.sourceCode,
          dependencies: args.dependencies,
        }
      )
      const fn = res.function
      if (!fn?.id) fail("Server returned a malformed function payload.")
      return { functionId: fn!.id, slug: fn!.slug, projectId: "" }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isSlugConflict = /already exists/i.test(msg) && /slug/i.test(msg)
      if (isSlugConflict && attempt < MAX_SLUG_ATTEMPTS) {
        candidate = bumpSlug(args.slug, attempt + 1)
        continue
      }
      fail(msg)
    }
  }
  // Unreachable — the loop either returns or fails.
  return { functionId: "", slug: args.slug, projectId: "" }
}

// Append a `-N` suffix, trimming so the slug stays within the 23-char budget
// the server enforces (it stitches the slug into an AWS Lambda function name).
function bumpSlug(base: string, n: number): string {
  const SLUG_HARD_MAX = 23
  const suffix = `-${n}`
  const maxBase = SLUG_HARD_MAX - suffix.length
  return base.slice(0, maxBase).replace(/-+$/, "") + suffix
}

// PUT a function secret. `buildApi` only exposes get/post/patch/del, so we do
// the raw fetch here (same pattern as `zavu fn secrets set`).
async function setSecret(
  functionId: string,
  key: string,
  value: string
): Promise<boolean> {
  try {
    const client = await buildClient()
    const res = await fetch(
      `${client.baseURL}/v1/functions/${functionId}/secrets/${key}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${client.apiKey}`,
        },
        body: JSON.stringify({ value }),
      }
    )
    return res.ok
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
