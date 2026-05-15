// Agents are nested under a sender (`/v1/senders/{senderId}/agent`). All
// commands take `--sender <senderId>` to identify the parent. Same pattern
// for the agent's sub-resources: flows, tools, knowledge bases.

import { Command } from "commander"
import { buildApi } from "../../lib/api"
import { loadJsonBody } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"

function agentBase(senderId: string) {
  return `/v1/senders/${senderId}/agent`
}

// Build the agent create/update body from individual --flags so the user
// never has to write a JSON file (and avoid terminal-paste indentation eating
// newlines inside `systemPrompt`). On create we require provider/model/prompt;
// on update we accept any subset.
async function buildAgentBodyFromFlags(
  opts: Record<string, any>,
  { partial = false }: { partial?: boolean } = {}
): Promise<Record<string, unknown>> {
  let prompt: string | undefined = opts.prompt
  if (!prompt && opts.promptFile) {
    const { readFile } = await import("node:fs/promises")
    prompt = (await readFile(opts.promptFile, "utf8")).trim()
  }

  const required = ["provider", "model"]
  if (!partial) {
    const missing = required.filter((k) => !opts[k])
    if (missing.length || !prompt) {
      fail(
        `Missing required flag(s): ${[...missing, ...(prompt ? [] : ["prompt"])]
          .map((x) => "--" + x)
          .join(", ")}. ` +
          "Either pass them as flags or use --file <path> with a JSON body."
      )
    }
  }

  const body: Record<string, unknown> = {}
  if (opts.name) body.name = opts.name
  if (opts.provider) body.provider = opts.provider
  if (opts.model) body.model = opts.model
  if (opts.apiKey) body.apiKey = opts.apiKey
  if (prompt) body.systemPrompt = prompt
  if (opts.contextWindow !== undefined) {
    const n = Number(opts.contextWindow)
    if (Number.isFinite(n)) body.contextWindowMessages = n
  }
  if (opts.channels) {
    body.triggerOnChannels = String(opts.channels)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (opts.messageTypes) {
    body.triggerOnMessageTypes = String(opts.messageTypes)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (opts.enabled !== undefined) {
    body.enabled = opts.enabled === "true" || opts.enabled === true
  }
  return body
}

export function agentsCommand(): Command {
  const cmd = new Command("agents").description("AI agents attached to senders.")

  cmd
    .command("get")
    .description("Show an agent's configuration.")
    .requiredOption("--sender <senderId>", "Sender ID")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        process.stdout.write(JSON.stringify(await api.get(agentBase(opts.sender)), null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  // `agents create` — two modes:
  //   (a) Named flags. Each option is its own shell arg so terminal paste
  //       indentation / line-wrap can't corrupt the value. Easier 95% path.
  //   (b) --data / --file fallback for full JSON when you need to set
  //       advanced fields (triggerOnChannels, includeContactMetadata, etc.).
  cmd
    .command("create")
    .description(
      "Create an agent. Use --prompt + --provider + --model for the common path, or --file for full JSON."
    )
    .requiredOption("--sender <senderId>", "Sender ID")
    .option("--name <name>", "Display name")
    .option("--provider <provider>", "openai | anthropic | google | mistral | zavu")
    .option("--model <model>", "Model id, e.g. gpt-4o-mini")
    .option("--api-key <key>", "Provider API key (omit if provider is 'zavu')")
    .option("--prompt <text>", "System prompt for the agent")
    .option("--prompt-file <path>", "Read system prompt from a text file")
    .option("--context-window <n>", "Previous messages included as context", "10")
    .option(
      "--channels <list>",
      "Comma-separated channels that trigger the agent",
      "*"
    )
    .option(
      "--message-types <list>",
      "Comma-separated message types that trigger the agent",
      "text"
    )
    .option("--data <json>", "Full JSON body (advanced)")
    .option("--file <path>", "Path to a JSON body file (advanced)")
    .action(async (opts) => {
      const body =
        opts.data || opts.file
          ? await loadJsonBody(opts)
          : await buildAgentBodyFromFlags(opts)
      const api = await buildApi()
      try {
        const res = await api.post(agentBase(opts.sender), body)
        ui.success("Agent created.")
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("update")
    .description("Update an agent. Mirror of `create` — same flag names, all optional.")
    .requiredOption("--sender <senderId>", "Sender ID")
    .option("--name <name>", "Display name")
    .option("--enabled <bool>", "true | false")
    .option("--provider <provider>")
    .option("--model <model>")
    .option("--api-key <key>")
    .option("--prompt <text>")
    .option("--prompt-file <path>")
    .option("--context-window <n>")
    .option("--channels <list>")
    .option("--message-types <list>")
    .option("--data <json>", "Full JSON body (advanced)")
    .option("--file <path>", "Path to a JSON body file (advanced)")
    .action(async (opts) => {
      const body =
        opts.data || opts.file
          ? await loadJsonBody(opts)
          : await buildAgentBodyFromFlags(opts, { partial: true })
      const api = await buildApi()
      try {
        const res = await api.patch(agentBase(opts.sender), body)
        ui.success("Updated.")
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("delete")
    .requiredOption("--sender <senderId>", "Sender ID")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        await api.del(agentBase(opts.sender))
        ui.success("Deleted.")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("stats")
    .requiredOption("--sender <senderId>", "Sender ID")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        process.stdout.write(
          JSON.stringify(await api.get(`${agentBase(opts.sender)}/stats`), null, 2) + "\n"
        )
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  cmd
    .command("executions")
    .description("List recent agent executions.")
    .requiredOption("--sender <senderId>", "Sender ID")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", "Page size", "20")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: any[] }>(`${agentBase(opts.sender)}/executions`, {
          status: opts.status,
          limit: opts.limit,
        })
        if (!res.items?.length) return ui.info("No executions.")
        ui.table(
          res.items.map((e) => ({
            id: e.id,
            status: e.status,
            tokens: `${e.inputTokens ?? 0}+${e.outputTokens ?? 0}`,
            cost: e.cost != null ? `$${e.cost.toFixed(4)}` : "—",
            ms: String(e.latencyMs ?? "—"),
          }))
        )
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  // Sub-resources: flows, tools, knowledge-bases. Tools have a dedicated
  // flag-friendly subgroup because its `parameters` field is a nested JSON
  // schema — using --file is unavoidable for that part, but the rest
  // (name, description, webhook) is easier as discrete flags.
  attachToolsSubResource(cmd)
  attachSubResource(cmd, "flows", "flowId", "/flows", { create: true, update: true, remove: true })
  attachSubResource(cmd, "knowledge-bases", "kbId", "/knowledge-bases", {
    create: true,
    update: true,
    remove: true,
  })

  return cmd
}

function attachToolsSubResource(parent: Command) {
  const sub = parent.command("tools").description("Manage agent tools.")

  sub
    .command("list")
    .requiredOption("--sender <senderId>", "Sender ID")
    .option("--limit <n>", "Page size", "20")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get(`${agentBase(opts.sender)}/tools`, {
          limit: opts.limit,
        })
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  sub
    .command("get <toolId>")
    .requiredOption("--sender <senderId>", "Sender ID")
    .action(async (toolId, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get(`${agentBase(opts.sender)}/tools/${toolId}`)
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  // Flag-first tool create. The hard-to-paste fields (--description,
  // --webhook) are discrete shell args; the only JSON-only piece is the
  // parameters schema, which goes through --params-file or --params.
  sub
    .command("create")
    .description(
      "Create a tool. Pass --name + --description + --webhook + --params-file."
    )
    .requiredOption("--sender <senderId>", "Sender ID")
    .option("--name <name>", "Tool name (lowercase_snake_case)")
    .option("--description <text>", "What the tool does — the LLM reads this")
    .option("--webhook <url>", "HTTPS endpoint to POST tool calls to")
    .option("--secret <secret>", "Optional HMAC secret for X-Zavu-Signature")
    .option("--params <json>", "Inline JSON schema for parameters")
    .option("--params-file <path>", "Path to a JSON file with the parameters schema")
    .option("--data <json>", "Full JSON body (advanced — skips other flags)")
    .option("--file <path>", "Full JSON body file (advanced)")
    .action(async (opts) => {
      const body =
        opts.data || opts.file
          ? await loadJsonBody(opts)
          : await buildToolBodyFromFlags(opts)
      const api = await buildApi()
      try {
        const res = await api.post(`${agentBase(opts.sender)}/tools`, body)
        ui.success("Tool created.")
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  sub
    .command("update <toolId>")
    .requiredOption("--sender <senderId>", "Sender ID")
    .option("--name <name>")
    .option("--description <text>")
    .option("--webhook <url>")
    .option("--secret <secret>")
    .option("--params <json>")
    .option("--params-file <path>")
    .option("--enabled <bool>")
    .option("--data <json>")
    .option("--file <path>")
    .action(async (toolId, opts) => {
      const body =
        opts.data || opts.file
          ? await loadJsonBody(opts)
          : await buildToolBodyFromFlags(opts, { partial: true })
      const api = await buildApi()
      try {
        const res = await api.patch(
          `${agentBase(opts.sender)}/tools/${toolId}`,
          body
        )
        ui.success("Updated.")
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  sub
    .command("delete <toolId>")
    .requiredOption("--sender <senderId>", "Sender ID")
    .action(async (toolId, opts) => {
      const api = await buildApi()
      try {
        await api.del(`${agentBase(opts.sender)}/tools/${toolId}`)
        ui.success("Deleted.")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}

async function buildToolBodyFromFlags(
  opts: Record<string, any>,
  { partial = false }: { partial?: boolean } = {}
): Promise<Record<string, unknown>> {
  // Parameters schema: --params (inline) wins over --params-file. If neither
  // given on create, default to an empty object schema so the call succeeds.
  let parameters: Record<string, unknown> | undefined
  if (opts.params) {
    try {
      parameters = JSON.parse(opts.params)
    } catch (err) {
      fail(`--params is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (opts.paramsFile) {
    const { readFile } = await import("node:fs/promises")
    const raw = await readFile(opts.paramsFile, "utf8")
    try {
      parameters = JSON.parse(raw)
    } catch (err) {
      fail(`${opts.paramsFile}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!partial) {
    const missing: string[] = []
    if (!opts.name) missing.push("--name")
    if (!opts.description) missing.push("--description")
    if (!opts.webhook) missing.push("--webhook")
    if (missing.length) {
      fail(
        `Missing required flag(s): ${missing.join(", ")}. ` +
          "Or pass --file <path> with a full JSON body."
      )
    }
    if (!parameters) {
      parameters = { type: "object", properties: {}, required: [] }
    }
  }

  const body: Record<string, unknown> = {}
  if (opts.name) body.name = opts.name
  if (opts.description) body.description = opts.description
  if (opts.webhook) body.webhookUrl = opts.webhook
  if (opts.secret) body.webhookSecret = opts.secret
  if (parameters) body.parameters = parameters
  if (opts.enabled !== undefined) {
    body.enabled = opts.enabled === "true" || opts.enabled === true
  }
  return body
}

function attachSubResource(
  parent: Command,
  groupName: string,
  idArg: string,
  pathSuffix: string,
  ops: { create?: boolean; update?: boolean; remove?: boolean }
) {
  const sub = parent
    .command(groupName)
    .description(`Manage agent ${groupName.replace(/-/g, " ")}.`)

  sub
    .command("list")
    .requiredOption("--sender <senderId>", "Sender ID")
    .option("--limit <n>", "Page size", "20")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get(`${agentBase(opts.sender)}${pathSuffix}`, {
          limit: opts.limit,
        })
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  sub
    .command(`get <${idArg}>`)
    .requiredOption("--sender <senderId>", "Sender ID")
    .action(async (id, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get(`${agentBase(opts.sender)}${pathSuffix}/${id}`)
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  if (ops.create) {
    sub
      .command("create")
      .requiredOption("--sender <senderId>", "Sender ID")
      .option("--data <json>", "Inline JSON body")
      .option("--file <path>", "Path to a JSON file")
      .action(async (opts) => {
        const body = await loadJsonBody(opts)
        const api = await buildApi()
        try {
          const res = await api.post(`${agentBase(opts.sender)}${pathSuffix}`, body)
          ui.success("Created.")
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
        }
      })
  }

  if (ops.update) {
    sub
      .command(`update <${idArg}>`)
      .requiredOption("--sender <senderId>", "Sender ID")
      .option("--data <json>", "Inline JSON body")
      .option("--file <path>", "Path to a JSON file")
      .action(async (id, opts) => {
        const body = await loadJsonBody(opts)
        const api = await buildApi()
        try {
          const res = await api.patch(`${agentBase(opts.sender)}${pathSuffix}/${id}`, body)
          ui.success("Updated.")
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
        }
      })
  }

  if (ops.remove) {
    sub
      .command(`delete <${idArg}>`)
      .requiredOption("--sender <senderId>", "Sender ID")
      .action(async (id, opts) => {
        const api = await buildApi()
        try {
          await api.del(`${agentBase(opts.sender)}${pathSuffix}/${id}`)
          ui.success("Deleted.")
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
        }
      })
  }
}
