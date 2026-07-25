// Agents are nested under a sender (`/v1/senders/{senderId}/agent`). All
// commands take `--sender <senderId>` to identify the parent. Same pattern
// for the agent's sub-resources: flows, tools, knowledge bases.

import { Command } from "commander"
import { buildApi } from "../../lib/api"
import { loadJsonBody } from "../../lib/resource"
import { ui, fail } from "../../lib/ui"
import { attachFactoryCommands } from "../agents/factory"

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

  cmd
    .command("list")
    .description("List every agent in the project, including ones with no sender.")
    .option("--limit <n>", "Page size", "50")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: any[]; nextCursor: string | null }>(
          "/v1/agents",
          { limit: opts.limit }
        )
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        if (!res.items?.length) {
          ui.info("No agents yet. Create one with `agents create` or `agents pull <id>`.")
          return
        }
        ui.table(
          res.items.map((a) => ({
            id: a.id,
            name: a.name,
            // A voice agent whose voice block is missing is the interesting
            // case, so show what the agent actually is, not what it is named.
            kind: a.voice?.enabled ? "voice" : "text",
            enabled: a.enabled ? "yes" : "no",
            senders: String((a.senderIds ?? []).length),
            model: a.model,
          }))
        )
        if (res.nextCursor) ui.hint("More results — pass --limit to see them.")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  // `agents senders` — an agent answers on N senders; this is how you wire them
  // up from code. Previously only reachable from the dashboard.
  const senders = cmd
    .command("senders")
    .description("Senders an agent answers on.")

  senders
    .command("connect")
    .description("Make the agent answer on a sender.")
    .requiredOption("--agent <agentId>", "Agent ID (see `agents list`)")
    .requiredOption("--sender <senderId>", "Sender ID (see `senders list`)")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.post<{ agent: { senderIds?: string[] } }>(
          `/v1/agents/${opts.agent}/senders`,
          { senderId: opts.sender }
        )
        ui.success("Sender connected.")
        ui.hint(`now answering on ${(res.agent.senderIds ?? []).length} sender(s)`)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  senders
    .command("disconnect")
    .description("Stop the agent answering on a sender.")
    .requiredOption("--agent <agentId>", "Agent ID")
    .requiredOption("--sender <senderId>", "Sender ID")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        await api.del(`/v1/agents/${opts.agent}/senders/${opts.sender}`)
        ui.success("Sender disconnected.")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  // `agents test` — the inner loop. Runs the agent and prints what it WOULD
  // reply, without sending anything to anyone and without charging the account,
  // so it is safe to run on every prompt edit. Everything else in this CLI
  // either needs a real channel or is read-only postmortem.
  cmd
    .command("test")
    .description("Send the agent a message and print its reply. Nothing is delivered.")
    .option("--agent <agentId>", "Agent ID (from `agents list`)")
    .option("--sender <senderId>", "Sender ID, if you'd rather address the agent by its sender")
    .requiredOption("--message <text>", "What to say to the agent")
    .option(
      "--turn <text...>",
      "Prior turns, alternating user/assistant, oldest first (repeatable)"
    )
    .option("--no-knowledge", "Skip knowledge-base retrieval")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      const api = await buildApi()
      // An agent is addressed by its own id. `--sender` resolves through the
      // sender-scoped lookup, which only ever finds ONE agent per sender.
      let agentId: string | undefined = opts.agent
      if (!agentId) {
        if (!opts.sender) {
          fail("Pass --agent <agentId> (see `agents list`) or --sender <senderId>.")
          return
        }
        try {
          const res = await api.get<{ agent: { id: string } | null }>(agentBase(opts.sender))
          if (!res.agent) {
            fail("That sender has no agent.")
            return
          }
          agentId = res.agent.id
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
          return
        }
      }
      // Alternating from the user, because a conversation always opens with one.
      const history = (opts.turn ?? []).map((content: string, i: number) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content,
      }))
      try {
        const res = await api.post<{
          success: boolean
          text: string | null
          error: string | null
          inputTokens: number
          outputTokens: number
          latencyMs: number
          knowledgeChunksUsed: number
          warnings: string[]
        }>(`/v1/agents/${agentId}/test`, {
          message: opts.message,
          ...(history.length ? { history } : {}),
          useKnowledgeBase: opts.knowledge !== false,
        })
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        if (!res.success) {
          fail(res.error || "Agent run failed")
          return
        }
        process.stdout.write("\n" + (res.text ?? "") + "\n\n")
        ui.hint(
          `${res.inputTokens}→${res.outputTokens} tokens · ${res.latencyMs}ms` +
            (res.knowledgeChunksUsed
              ? ` · ${res.knowledgeChunksUsed} knowledge chunk(s)`
              : "")
        )
        // Printed loudly: the whole point is that a dry run must never be
        // mistaken for proof that the agent works on a real channel.
        for (const w of res.warnings ?? []) ui.warn(w)
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
    .option("--enabled <bool>", "Answer real messages right away. Default false.")
    .option("--data <json>", "Full JSON body (advanced)")
    .option("--file <path>", "Path to a JSON body file (advanced)")
    .action(async (opts) => {
      const body =
        opts.data || opts.file
          ? await loadJsonBody(opts)
          : await buildAgentBodyFromFlags(opts)
      const api = await buildApi()
      try {
        const res = await api.post<{ agent?: { enabled?: boolean } }>(
          agentBase(opts.sender),
          body
        )
        ui.success("Agent created.")
        // An agent is created off. Saying so here — rather than leaving it as
        // one line of a 25-line JSON blob — is the difference between knowing
        // and finding out when nobody gets an answer.
        if (res.agent && res.agent.enabled === false) {
          ui.warn(
            "Created disabled: it will not answer real messages yet. Turn it on with `agents update --sender <id> --enabled true`."
          )
        }
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

  // `executions` is a command group with `list` (default) and `get` subcommands.
  // For backwards-compat we still accept `zavu agents executions --sender X`
  // (no subcommand) and treat it as `list`.
  const executions = cmd
    .command("executions")
    .description("Agent execution history (list / get single).")

  executions
    .command("list", { isDefault: true })
    .description("List recent agent executions.")
    .requiredOption("--sender <senderId>", "Sender ID")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", "Page size", "20")
    .option("--json", "Output full JSON (includes errorMessage)")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: any[] }>(`${agentBase(opts.sender)}/executions`, {
          status: opts.status,
          limit: opts.limit,
        })
        if (!res.items?.length) {
          ui.info("No executions.")
          return
        }
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2))
          return
        }
        ui.table(
          res.items.map((e) => ({
            id: e.id,
            status: e.status,
            tokens: `${e.inputTokens ?? 0}+${e.outputTokens ?? 0}`,
            cost: e.cost != null ? `$${e.cost.toFixed(4)}` : "—",
            ms: String(e.latencyMs ?? "—"),
          }))
        )
        // Surface the error reason for any failed executions so the user
        // doesn't have to drop to curl to diagnose. Truncated to keep the
        // output tight; --json shows the full payload.
        const errored = res.items.filter((e) => e.status !== "success" && e.errorMessage)
        if (errored.length > 0) {
          ui.info("\nError details:")
          for (const e of errored) {
            const msg = String(e.errorMessage).slice(0, 200)
            ui.hint(`${e.id}  [${e.errorCode ?? e.status}]  ${msg}`)
          }
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  executions
    .command("get <executionId>")
    .description("Show a single execution with full error/response details.")
    .requiredOption("--sender <senderId>", "Sender ID")
    .option("--json", "Output full JSON")
    .action(async (executionId, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ execution: any }>(
          `${agentBase(opts.sender)}/executions/${executionId}`
        )
        const e = res.execution
        if (opts.json) {
          console.log(JSON.stringify(e, null, 2))
          return
        }
        // Human-readable detail view. Keep it dense but scannable.
        ui.info(`id:           ${e.id}`)
        ui.info(`agentId:      ${e.agentId}`)
        ui.info(`status:       ${e.status}`)
        if (e.inboundMessageId) ui.info(`inboundMsg:   ${e.inboundMessageId}`)
        if (e.responseMessageId) ui.info(`responseMsg:  ${e.responseMessageId}`)
        ui.info(`tokens in:    ${e.inputTokens ?? 0}`)
        ui.info(`tokens out:   ${e.outputTokens ?? 0}`)
        ui.info(`cost:         $${(e.cost ?? 0).toFixed(6)}`)
        ui.info(`latency:      ${e.latencyMs ?? "—"} ms`)
        ui.info(`createdAt:    ${e.createdAt}`)
        if (e.errorMessage) {
          ui.info(`\nerror code:   ${e.errorCode ?? "(none)"}`)
          ui.info(`error message:`)
          ui.hint(e.errorMessage)
        }
        if (e.responseText) {
          ui.info(`\nresponse text:`)
          ui.hint(e.responseText)
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  // Reset the agent's conversation context for one contact. Common dev loop:
  //   1. edit code
  //   2. zavu deploy
  //   3. zavu agents reset-thread --sender X --contact +1415...
  //   4. send a test message — agent starts fresh, no leftover context
  cmd
    .command("reset-thread")
    .description("Close the active conversation thread + flow sessions for one contact so the agent starts fresh on the next inbound.")
    .requiredOption("--sender <senderId>", "Sender ID")
    .option("--contact <identifier>", "Phone (E.164), email, or 'telegram:<chatId>'")
    .option("--contact-id <id>", "Contact ID (skip identifier lookup)")
    .action(async (opts) => {
      const api = await buildApi()
      if (!opts.contact && !opts.contactId) {
        fail("Pass --contact <phone|email|telegram:id> or --contact-id <id>")
      }
      try {
        const res = await api.post<{ threadsClosed: number; sessionsClosed: number }>(
          `${agentBase(opts.sender)}/threads/reset`,
          opts.contactId
            ? { contactId: opts.contactId }
            : { contactIdentifier: opts.contact }
        )
        ui.success(
          `Closed ${res.threadsClosed} thread${res.threadsClosed === 1 ? "" : "s"} and ${res.sessionsClosed} session${res.sessionsClosed === 1 ? "" : "s"}. Next inbound starts fresh.`
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
  const kb = attachSubResource(cmd, "knowledge-bases", "kbId", "/knowledge-bases", {
    create: true,
    update: true,
    remove: true,
    createFlags: [
      { key: "name", description: "Knowledge base name" },
      { key: "description", description: "What this knowledge base holds" },
    ],
  })
  attachKnowledgeBaseDocuments(kb)

  // Factory agents: `zavu agents catalog` + `zavu agents pull <id>`.
  attachFactoryCommands(cmd)

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

/**
 * Documents inside a knowledge base.
 *
 * Without these, the CLI could create an empty knowledge base and nothing else,
 * so retrieval — the difference between an agent that cites your docs and one
 * that invents them — was reachable only by hand-rolling REST calls.
 */
function attachKnowledgeBaseDocuments(kb: Command) {
  const docs = kb
    .command("documents")
    .description("Documents inside a knowledge base. This is what RAG retrieves.")

  const docsBase = (senderId: string, kbId: string) =>
    `${agentBase(senderId)}/knowledge-bases/${kbId}/documents`

  docs
    .command("list")
    .requiredOption("--sender <senderId>", "Sender ID")
    .requiredOption("--kb <kbId>", "Knowledge base ID")
    .option("--limit <n>", "Page size", "50")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get(docsBase(opts.sender, opts.kb), { limit: opts.limit })
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  docs
    .command("add")
    .description("Add a document. It is chunked and embedded automatically.")
    .requiredOption("--sender <senderId>", "Sender ID")
    .requiredOption("--kb <kbId>", "Knowledge base ID")
    .requiredOption("--title <title>", "Document title")
    .option("--content <text>", "Document body")
    // A knowledge base is usually a file on disk, not something you paste into
    // a shell — and pasting loses the newlines that chunking relies on.
    .option("--content-file <path>", "Read the body from a file")
    .action(async (opts) => {
      let content: string | undefined = opts.content
      if (!content && opts.contentFile) {
        const { readFile } = await import("node:fs/promises")
        content = await readFile(opts.contentFile, "utf8")
      }
      if (!content) {
        fail("Provide the document body with --content <text> or --content-file <path>.")
        return
      }
      const api = await buildApi()
      try {
        const res = await api.post(docsBase(opts.sender, opts.kb), {
          title: opts.title,
          content,
        })
        ui.success("Document added.")
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
        ui.hint(
          "Processing takes a few seconds. Verify with `agents test` — it reports how many knowledge chunks were used."
        )
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  docs
    .command("get <docId>")
    .requiredOption("--sender <senderId>", "Sender ID")
    .requiredOption("--kb <kbId>", "Knowledge base ID")
    .action(async (docId, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get(`${docsBase(opts.sender, opts.kb)}/${docId}`)
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  docs
    .command("delete <docId>")
    .requiredOption("--sender <senderId>", "Sender ID")
    .requiredOption("--kb <kbId>", "Knowledge base ID")
    .action(async (docId, opts) => {
      const api = await buildApi()
      try {
        await api.del(`${docsBase(opts.sender, opts.kb)}/${docId}`)
        ui.success("Deleted.")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}

function attachSubResource(
  parent: Command,
  groupName: string,
  idArg: string,
  pathSuffix: string,
  ops: {
    create?: boolean
    update?: boolean
    remove?: boolean
    createFlags?: Array<{ key: string; description: string }>
  }
): Command {
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
    const create = sub
      .command("create")
      .requiredOption("--sender <senderId>", "Sender ID")
      .option("--data <json>", "Inline JSON body")
      .option("--file <path>", "Path to a JSON file")
    // Simple resources get discrete flags so nobody has to hand-write JSON for
    // a two-field body — `--data '{"name":"..."}'` is a hostile first
    // experience, and a malformed brace only ever came back as
    // "Invalid request body".
    for (const f of ops.createFlags ?? []) {
      create.option(`--${f.key} <value>`, f.description)
    }
    create.action(async (opts) => {
      const body =
        opts.data || opts.file
          ? await loadJsonBody(opts)
          : Object.fromEntries(
              (ops.createFlags ?? [])
                .filter((f) => opts[f.key] !== undefined)
                .map((f) => [f.key, opts[f.key]])
            )
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

  return sub
}
