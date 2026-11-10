// `zavudev memory` — what your agents remember between messages.
//
// Two halves of one product, mirroring /v1/memory:
//   - Facts, recalled by meaning. `memory add` / `search` — for "she is
//     allergic to peanuts", which nobody would think to look up under a key.
//   - Collections, read and written by key. `memory collection set/get/...` —
//     for the booking, the cart, the counter.
//
// Both take the same scope flags, so state can belong to the project, one
// contact, or one conversation.

import { Command } from "commander"
import { readFile } from "node:fs/promises"
import { buildApi, ApiClient } from "../../lib/api"
import { ui, fail, cli } from "../../lib/ui"
import {
  BatchOp,
  chunk,
  describeScope,
  describeValueType,
  buildQueryWhere,
  formatBytes,
  formatCount,
  formatQuota,
  parseLooseValue,
  parseMetadataPairs,
  parseNdjson,
  parseStrictJson,
  previewValue,
  resolveScope,
  ScopeError,
  ScopeSelection,
  scopeToBody,
  scopeToQuery,
} from "../../lib/memoryIo"

const BASE = "/v1/memory"
const COLLECTIONS = `${BASE}/collections`
const BATCH_SIZE = 25

interface MemoryRecord {
  id: string
  text?: string
  metadata?: Record<string, string>
  score?: number
  createdAt: string
  expiresAt?: string
}

interface CollectionItem {
  key: string
  value?: unknown
  rev: number
  createdAt: string
  updatedAt: string
  expiresAt?: string
}

interface MemoryCollection {
  name: string
  indexes: Array<{ field: string }>
  defaultTtlSeconds: number | null
  status: string
  createdAt: string
  updatedAt: string
}

// --- Shared plumbing ----------------------------------------------------------

function scopeFrom(opts: { scope?: string; contact?: string; conversation?: string }): ScopeSelection {
  try {
    return resolveScope(opts)
  } catch (err) {
    if (err instanceof ScopeError) fail(err.message)
    throw err
  }
}

/** The three scope flags, added identically to every subcommand. */
function withScopeFlags(cmd: Command): Command {
  return cmd
    .option(
      "--scope <scope>",
      "project (default), contact:<contactId>, or conversation:<conversationId>"
    )
    .option("--contact <id>", "Contact id, when --scope is just 'contact'")
    .option("--conversation <id>", "Conversation id, when --scope is just 'conversation'")
}

function itemsPath(collection: string): string {
  return `${COLLECTIONS}/${encodeURIComponent(collection)}/items`
}

function itemPath(collection: string, key: string): string {
  return `${itemsPath(collection)}/${encodeURIComponent(key)}`
}

function parseLimit(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    fail(`${label} takes a whole number, got "${raw}".`)
  }
  return n
}

function parseTtl(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    fail(`${label} takes a whole number of seconds, got "${raw}".`)
  }
  return n
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const part of process.stdin) {
    chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part))
  }
  return Buffer.concat(chunks).toString("utf8")
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ")
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

export function memoryCommand(): Command {
  const cmd = new Command("memory").description(
    "What your agents remember: facts recalled by meaning, and collections read by key."
  )
  // Plural manages the set, singular operates inside one. Stated here because
  // `memory collections list` and `memory collection list <name>` are one
  // letter apart and answer completely different questions.
  cmd.addHelpText(
    "after",
    `
Two halves:
  ${cli('memory add "..."')}                      remember a fact, recalled by meaning
  ${cli("memory collection set <name> <key> ...")}  write a document, read back by key

Plural manages the set of collections, singular operates inside one:
  ${cli("memory collections list")}                 which collections exist
  ${cli("memory collection list <name>")}           what is inside one of them
`
  )
  const apiFactory = () => buildApi()

  attachFacts(cmd, apiFactory)
  attachCollections(cmd, apiFactory)
  attachCollectionOps(cmd, apiFactory)
  attachUsage(cmd, apiFactory)

  return cmd
}

// --- Facts --------------------------------------------------------------------

function attachFacts(parent: Command, apiFactory: () => Promise<ApiClient>) {
  const add = parent
    .command("add <text>")
    .description("Remember a fact. Pass '-' to read the text from stdin.")
    .option(
      "--metadata <key=value>",
      "Attach metadata. Repeatable.",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .option("--file <path>", "Read the text from a file instead")
    .option("--ttl <seconds>", "Forget it automatically after this long")
    .option("--json", "Print the raw JSON response")
  withScopeFlags(add).action(async (text: string, opts) => {
    const scope = scopeFrom(opts)
    let body: string
    if (opts.file) {
      body = (await readFile(opts.file, "utf8")).trim()
    } else if (text === "-") {
      body = (await readStdin()).trim()
    } else {
      body = text
    }
    if (!body) fail("Nothing to remember: the text is empty.")

    let metadata: Record<string, string> | undefined
    try {
      metadata = parseMetadataPairs(opts.metadata)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }

    const api = await apiFactory()
    try {
      const res = await api.post<{ memory: { id: string; expiresAt?: string } }>(BASE, {
        text: body,
        ...scopeToBody(scope),
        ...(metadata ? { metadata } : {}),
        ...(opts.ttl !== undefined ? { ttlSeconds: parseTtl(opts.ttl, "--ttl") } : {}),
      })
      if (opts.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
        return
      }
      ui.success(`Remembered (${describeScope(scope)}): ${res.memory.id}`)
      if (res.memory.expiresAt) ui.hint(`forgotten after ${res.memory.expiresAt}`)
      // A fact is only useful if it comes back, and a scope mismatch is the
      // usual reason it does not, so point at the matching search.
      ui.hint(
        `Check it comes back: ${cli(
          `memory search "..."${scopeToQuery(scope) ? ` --scope ${scopeToQuery(scope)}` : ""}`
        )}`
      )
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })

  const search = parent
    .command("search <query>")
    .description("Find remembered facts by meaning, best match first.")
    .option("--limit <n>", "How many to return (max 20)", "5")
    .option("--min-score <score>", "Drop matches below this similarity, 0 to 1")
    .option("--json", "Print the raw JSON response")
  withScopeFlags(search).action(async (query: string, opts) => {
    const scope = scopeFrom(opts)
    let minScore: number | undefined
    if (opts.minScore !== undefined) {
      const n = Number(opts.minScore)
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        fail(`--min-score takes a number between 0 and 1, got "${opts.minScore}".`)
      }
      minScore = n
    }

    const api = await apiFactory()
    try {
      const res = await api.post<{ items: MemoryRecord[] }>(`${BASE}/search`, {
        query,
        ...scopeToBody(scope),
        ...(opts.limit !== undefined ? { limit: parseLimit(opts.limit, "--limit") } : {}),
        ...(minScore !== undefined ? { minScore } : {}),
      })
      if (opts.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
        return
      }
      if (!res.items?.length) {
        ui.info(`Nothing remembered matches that (${describeScope(scope)}).`)
        // The project scope never sees a contact's facts, and vice versa. That
        // is by design, and it is also the first thing to check.
        if (scope.kind === "project") {
          ui.hint(
            "This searched the project scope only. A fact remembered for a contact or a conversation needs the same --scope to come back."
          )
        }
        return
      }
      for (const item of res.items) {
        const score = typeof item.score === "number" ? item.score.toFixed(3) : "—"
        process.stdout.write(`${score}  ${item.text ?? ""}\n`)
        const meta = item.metadata
        if (meta && Object.keys(meta).length) {
          ui.hint(
            Object.entries(meta)
              .map(([k, v]) => `${k}=${v}`)
              .join("  ")
          )
        }
        ui.hint(item.id)
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })

  const list = parent
    .command("list")
    .description("List remembered facts in a scope, newest first.")
    .option("--limit <n>", "Page size", "50")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the raw JSON response")
  withScopeFlags(list).action(async (opts) => {
    const scope = scopeFrom(opts)
    const api = await apiFactory()
    try {
      const res = await api.get<{ items: MemoryRecord[]; nextCursor: string | null }>(BASE, {
        scope: scopeToQuery(scope),
        limit: parseLimit(opts.limit, "--limit"),
        cursor: opts.cursor,
      })
      if (opts.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
        return
      }
      if (!res.items?.length) {
        ui.info(`Nothing remembered yet (${describeScope(scope)}).`)
        ui.hint(`Add one with ${cli('memory add "..."')}`)
        return
      }
      ui.table(
        res.items.map((m) => ({
          id: m.id,
          text: truncate(m.text ?? "", 64),
          created: m.createdAt,
          expires: m.expiresAt ?? "—",
        }))
      )
      if (res.nextCursor) ui.hint(`More: --cursor ${res.nextCursor}`)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })

  const get = parent
    .command("get <memoryId>")
    .description("Show one remembered fact.")
    .option("--json", "Print the raw JSON response")
  withScopeFlags(get).action(async (memoryId: string, opts) => {
    const scope = scopeFrom(opts)
    const api = await apiFactory()
    try {
      const res = await api.get<{ memory: MemoryRecord }>(
        `${BASE}/${encodeURIComponent(memoryId)}`,
        { scope: scopeToQuery(scope) }
      )
      process.stdout.write(JSON.stringify(opts.json ? res : res.memory, null, 2) + "\n")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })

  const del = parent.command("delete <memoryId>").description("Forget one fact.")
  withScopeFlags(del).action(async (memoryId: string, opts) => {
    const scope = scopeFrom(opts)
    const api = await apiFactory()
    try {
      await api.del(`${BASE}/${encodeURIComponent(memoryId)}`, {
        query: { scope: scopeToQuery(scope) },
      })
      ui.success(`Forgot ${memoryId}.`)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })

  const wipe = parent
    .command("wipe")
    .description("Forget every fact in a scope. Asks for confirmation.")
    .option("--yes", "Skip the confirmation (for scripts)")
  withScopeFlags(wipe).action(async (opts) => {
    const scope = scopeFrom(opts)
    const label = describeScope(scope)

    if (!opts.yes) {
      // The project scope is the destructive one: it is the default, so a
      // missing --scope would wipe everything when the user meant one contact.
      const expected = scope.kind === "project" ? "project" : scope.id
      const confirmed = await confirmDestructive(
        `About to forget every fact in the ${label} scope. This cannot be undone.`,
        expected
      )
      if (!confirmed) {
        ui.info("Cancelled.")
        return
      }
    }

    const api = await apiFactory()
    try {
      await api.del(BASE, { query: { scope: scopeToQuery(scope) } })
      // 202: rows are removed in the background, so a search right after this
      // can still return something.
      ui.success(`Wiping every fact in the ${label} scope.`)
      ui.hint("This runs in the background; a search may still return results for a moment.")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })
}

// --- Collections (manage the set) ----------------------------------------------

function attachCollections(parent: Command, apiFactory: () => Promise<ApiClient>) {
  const collections = parent
    .command("collections")
    .description("The set of collections: what exists, their indexes and default TTL.")

  collections
    .command("list")
    .description("List the collections in this project.")
    .option("--limit <n>", "Page size", "50")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      const api = await apiFactory()
      try {
        const res = await api.get<{ items: MemoryCollection[]; nextCursor: string | null }>(
          COLLECTIONS,
          { limit: parseLimit(opts.limit, "--limit"), cursor: opts.cursor }
        )
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        if (!res.items?.length) {
          ui.info("No collections yet.")
          ui.hint(
            `Writing an item creates one: ${cli("memory collection set <name> <key> <value>")}`
          )
          return
        }
        ui.table(
          res.items.map((c) => ({
            name: c.name,
            status: c.status,
            indexes: c.indexes?.length ? c.indexes.map((i) => i.field).join(",") : "—",
            defaultTtl: c.defaultTtlSeconds == null ? "—" : `${c.defaultTtlSeconds}s`,
          }))
        )
        if (res.nextCursor) ui.hint(`More: --cursor ${res.nextCursor}`)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  collections
    .command("create <name>")
    .description(
      "Create a collection up front. Only needed for indexes or a default TTL: a write creates the collection on its own."
    )
    // Indexes cannot be added later, and the first write creates the collection
    // without any — so a collection you plan to query has to be created here,
    // before anything is written to it.
    //
    // This flag's spelling is quoted back to the user from two other places:
    // the `field_not_indexed` recovery steps below, and the local stub's query
    // warning in @zavudev/functions (stubQueryWarning). Renaming it means
    // fixing those strings too.
    .option(
      "--index <field>",
      "Index a top-level field so `memory collection query` can match on it. Repeatable, max 2. Cannot be changed later.",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .option("--default-ttl <seconds>", "Expire items after this long unless a write overrides it")
    .option("--json", "Print the raw JSON response")
    .action(async (name: string, opts) => {
      if (opts.index.length > 2) {
        fail(`A collection takes at most 2 indexes; got ${opts.index.length}.`)
      }
      const api = await apiFactory()
      try {
        const res = await api.post<{ collection: MemoryCollection }>(COLLECTIONS, {
          name,
          ...(opts.index.length ? { indexes: opts.index.map((field: string) => ({ field })) } : {}),
          ...(opts.defaultTtl !== undefined
            ? { defaultTtlSeconds: parseTtl(opts.defaultTtl, "--default-ttl") }
            : {}),
        })
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        ui.success(`Created collection "${res.collection.name}".`)
        if (res.collection.indexes?.length) {
          ui.hint(`indexed: ${res.collection.indexes.map((i) => i.field).join(", ")}`)
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  collections
    .command("get <name>")
    .description("Show a collection's indexes, default TTL, and status.")
    .option("--json", "Print the raw JSON response")
    .action(async (name: string, opts) => {
      const api = await apiFactory()
      try {
        const res = await api.get<{ collection: MemoryCollection }>(
          `${COLLECTIONS}/${encodeURIComponent(name)}`
        )
        process.stdout.write(JSON.stringify(opts.json ? res : res.collection, null, 2) + "\n")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  collections
    .command("update <name>")
    .description("Change a collection's default TTL. Indexes are fixed at creation.")
    .option("--default-ttl <seconds>", "New default TTL")
    .option("--clear-default-ttl", "Stop expiring new items by default")
    .action(async (name: string, opts) => {
      if (!opts.defaultTtl && !opts.clearDefaultTtl) {
        fail("Pass --default-ttl <seconds> or --clear-default-ttl.")
      }
      if (opts.defaultTtl && opts.clearDefaultTtl) {
        fail("Pass either --default-ttl or --clear-default-ttl, not both.")
      }
      const api = await apiFactory()
      try {
        const res = await api.patch<{ collection: MemoryCollection }>(
          `${COLLECTIONS}/${encodeURIComponent(name)}`,
          {
            defaultTtlSeconds: opts.clearDefaultTtl
              ? null
              : parseTtl(opts.defaultTtl, "--default-ttl"),
          }
        )
        ui.success(
          res.collection.defaultTtlSeconds == null
            ? `"${name}" no longer expires items by default.`
            : `"${name}" now expires items after ${res.collection.defaultTtlSeconds}s by default.`
        )
        ui.hint("Existing items keep the expiry they were written with.")
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })

  collections
    .command("delete <name>")
    .description("Delete a collection and everything in it. Asks for confirmation.")
    .option("--yes", "Skip the confirmation (for scripts)")
    .action(async (name: string, opts) => {
      if (!opts.yes) {
        const confirmed = await confirmDestructive(
          `Delete collection "${name}" and every item in it?`,
          name
        )
        if (!confirmed) {
          ui.info("Cancelled.")
          return
        }
      }
      const api = await apiFactory()
      try {
        await api.del(`${COLLECTIONS}/${encodeURIComponent(name)}`)
        // 202: the rows are purged in the background and writes are refused
        // meanwhile. Saying "deleted" would invite a re-create that fails.
        ui.success(`Deleting "${name}".`)
        ui.hint(
          `Items are purged in the background; writes to it are refused until that finishes. Check with ${cli(`memory collections get ${name}`)}.`
        )
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}

// --- Collection (operate inside one) --------------------------------------------

function attachCollectionOps(parent: Command, apiFactory: () => Promise<ApiClient>) {
  const collection = parent
    .command("collection")
    .description("Read and write inside one collection. The name follows the verb.")

  const set = collection
    .command("set <collection> <key> [value]")
    .description(
      "Write an item. The value can be an argument, --data, --file, or '-' for stdin."
    )
    .option("--data <json>", "Inline JSON value")
    .option("--file <path>", "Read the JSON value from a file")
    .option("--ttl <seconds>", "Expire this item after this long")
    .option(
      "--if-match <rev>",
      "Only write if the stored revision is still this one (from a previous read)"
    )
    .option("--json", "Print the raw JSON response")
  withScopeFlags(set).action(
    async (collectionName: string, key: string, value: string | undefined, opts) => {
      const scope = scopeFrom(opts)
      const parsed = await resolveItemValue(value, opts)
      const api = await apiFactory()
      try {
        const res = await api.put<{ item: CollectionItem }>(
          itemPath(collectionName, key),
          {
            value: parsed,
            ...(opts.ttl !== undefined ? { ttlSeconds: parseTtl(opts.ttl, "--ttl") } : {}),
          },
          {
            query: { scope: scopeToQuery(scope) },
            ...(opts.ifMatch !== undefined
              ? { headers: { "If-Match": String(opts.ifMatch) } }
              : {}),
          }
        )
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        // The type is printed because a bare `42` at a shell is stored as a
        // number and `"42"` as a string, and finding that out on the read side
        // is a bad way to find out.
        ui.success(
          `Wrote ${collectionName}/${key} as ${describeValueType(parsed)} (rev ${res.item.rev}, ${describeScope(scope)}).`
        )
        if (res.item.expiresAt) ui.hint(`expires ${res.item.expiresAt}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (opts.ifMatch !== undefined && /precondition|if-match|rev/i.test(msg)) {
          fail(
            `${msg}\n  Someone else wrote to ${collectionName}/${key} first. Read it again with ` +
              `\`${cli(`memory collection get ${collectionName} ${key}`)}\` and retry with the new rev.`
          )
        }
        fail(msg)
      }
    }
  )

  const get = collection
    .command("get <collection> <key>")
    .description("Read one item. Prints the value; --json adds the revision and timestamps.")
    .option("--json", "Print the full item, not only its value")
  withScopeFlags(get).action(async (collectionName: string, key: string, opts) => {
    const scope = scopeFrom(opts)
    const api = await apiFactory()
    try {
      const res = await api.get<{ item: CollectionItem }>(itemPath(collectionName, key), {
        scope: scopeToQuery(scope),
      })
      if (opts.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
        return
      }
      // Bare value on stdout so it pipes into jq and friends.
      process.stdout.write(JSON.stringify(res.item.value, null, 2) + "\n")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })

  const del = collection
    .command("del <collection> <key>")
    .alias("delete")
    .description("Delete one item. Deleting a key that is not there still succeeds.")
  withScopeFlags(del).action(async (collectionName: string, key: string, opts) => {
    const scope = scopeFrom(opts)
    const api = await apiFactory()
    try {
      await api.del(itemPath(collectionName, key), { query: { scope: scopeToQuery(scope) } })
      ui.success(`Deleted ${collectionName}/${key} (${describeScope(scope)}).`)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })

  const list = collection
    .command("list <collection>")
    .description("List items by key order, optionally under a prefix.")
    .option("--prefix <prefix>", "Only keys starting with this")
    .option("--limit <n>", "Page size", "50")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the raw JSON response")
  withScopeFlags(list).action(async (collectionName: string, opts) => {
    const scope = scopeFrom(opts)
    const api = await apiFactory()
    try {
      const res = await api.get<{ items: CollectionItem[]; nextCursor: string | null }>(
        itemsPath(collectionName),
        {
          prefix: opts.prefix,
          limit: parseLimit(opts.limit, "--limit"),
          cursor: opts.cursor,
          scope: scopeToQuery(scope),
        }
      )
      if (opts.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
        return
      }
      printItems(res.items ?? [], res.nextCursor, collectionName)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })

  const query = collection
    .command("query <collection>")
    .description("Find items by an indexed field. The field must have been indexed at creation.")
    .requiredOption("--field <name>", "Indexed field to match")
    .option(
      "--eq <value>",
      "Exact match. Parsed as JSON when it parses: 42 is a number, '\"42\"' a string"
    )
    .option("--begins-with <prefix>", "String prefix match")
    .option("--between <bounds...>", "Range match: --between <from> <to>")
    .option("--limit <n>", "Page size", "50")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the raw JSON response")
  withScopeFlags(query).action(async (collectionName: string, opts) => {
    const scope = scopeFrom(opts)
    let where
    try {
      where = buildQueryWhere(opts)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
      return
    }
    const api = await apiFactory()
    try {
      const res = await api.post<{ items: CollectionItem[]; nextCursor: string | null }>(
        `${COLLECTIONS}/${encodeURIComponent(collectionName)}/query`,
        {
          where,
          limit: parseLimit(opts.limit, "--limit") ?? 50,
          ...(opts.cursor ? { cursor: opts.cursor } : {}),
        },
        { query: { scope: scopeToQuery(scope) } }
      )
      if (opts.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n")
        return
      }
      if (!res.items?.length) {
        ui.info("No items matched.")
        return
      }
      printItems(res.items, res.nextCursor, collectionName)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // A collection is created by its first write, and one created that way
      // has no indexes at all. The server names the field; what it cannot say
      // is that indexes are fixed at creation, so the fix is to rebuild the
      // collection rather than to add an index to it.
      if (/field_not_indexed/.test(msg)) {
        fail(
          `${msg}\n` +
            `  Indexes are set when the collection is created and cannot be added later, and a\n` +
            `  collection created by its first write has none. To query "${where.field}", rebuild it:\n` +
            `    ${cli(`memory collection export ${collectionName}`)} > ${collectionName}.ndjson\n` +
            `    ${cli(`memory collections delete ${collectionName}`)}\n` +
            `    ${cli(`memory collections create ${collectionName} --index ${where.field}`)}\n` +
            `    ${cli(`memory collection import ${collectionName}`)} --file ${collectionName}.ndjson`
        )
      }
      if (/collection_not_found/.test(msg)) {
        fail(`${msg}\n  See what exists with ${cli("memory collections list")}.`)
      }
      fail(msg)
    }
  })

  const exportCmd = collection
    .command("export <collection>")
    .description("Write every item to stdout as NDJSON, one item per line.")
    .option("--prefix <prefix>", "Only keys starting with this")
    .option("--page-size <n>", "Items fetched per request", "100")
  withScopeFlags(exportCmd).action(async (collectionName: string, opts) => {
    const scope = scopeFrom(opts)
    const api = await apiFactory()
    let cursor: string | undefined
    let count = 0
    try {
      do {
        const res = await api.get<{ items: CollectionItem[]; nextCursor: string | null }>(
          itemsPath(collectionName),
          {
            prefix: opts.prefix,
            limit: parseLimit(opts.pageSize, "--page-size"),
            cursor,
            scope: scopeToQuery(scope),
          }
        )
        for (const item of res.items ?? []) {
          process.stdout.write(
            JSON.stringify({
              key: item.key,
              value: item.value,
              rev: item.rev,
              ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
            }) + "\n"
          )
          count++
        }
        cursor = res.nextCursor ?? undefined
      } while (cursor)
    } catch (err) {
      // Partial output has already been written, so say how far it got: a
      // truncated file that looks complete is the worst outcome here.
      process.stderr.write(
        `\n✗ Export stopped after ${count} item(s): ${err instanceof Error ? err.message : String(err)}\n`
      )
      process.exit(1)
    }
    // stderr, so `memory collection export … > file.ndjson` keeps the file clean.
    process.stderr.write(`  exported ${count} item(s) from ${collectionName}\n`)
  })

  const importCmd = collection
    .command("import <collection>")
    .description(
      "Read NDJSON from stdin or --file and write it back. Accepts what `export` produces."
    )
    .option("--file <path>", "Read from a file instead of stdin")
    .option("--dry-run", "Parse and report, without writing anything")
  withScopeFlags(importCmd).action(async (collectionName: string, opts) => {
    const scope = scopeFrom(opts)
    // Reading a terminal would look like a hang with no output at all, and the
    // person who typed this meant to pipe a file in.
    if (!opts.file && process.stdin.isTTY) {
      fail(
        `Nothing to read. Pipe NDJSON in, or pass --file <path>.\n` +
          `  Example: ${cli("memory collection export old")} | ${cli(`memory collection import ${collectionName}`)}`
      )
    }
    const text = opts.file ? await readFile(opts.file, "utf8") : await readStdin()
    if (text.trim() === "") {
      fail(opts.file ? `${opts.file} is empty.` : "Nothing on stdin.")
    }

    const { ops, errors } = parseNdjson(text)
    for (const e of errors) ui.warn(`line ${e.line}: ${e.reason}`)
    if (ops.length === 0) {
      fail("No usable records. Each line must be a JSON object with a 'key' and a 'value'.")
    }
    if (opts.dryRun) {
      ui.info(
        `${ops.length} record(s) would be written to ${collectionName} (${describeScope(scope)}), ${errors.length} skipped.`
      )
      return
    }

    const api = await apiFactory()
    let added = 0
    const failures: Array<{ key: string; reason: string }> = []
    const batches = chunk(ops, BATCH_SIZE)

    for (const [index, batch] of batches.entries()) {
      try {
        const res = await api.post<{
          results: Array<{ key: string; ok: boolean; rev?: number; error?: string }>
        }>(
          `${itemsPath(collectionName)}/batch`,
          { ops: batch as BatchOp[] },
          { query: { scope: scopeToQuery(scope) } }
        )
        for (const r of res.results ?? []) {
          if (r.ok) added++
          else failures.push({ key: r.key, reason: r.error ?? "rejected" })
        }
      } catch (err) {
        // A whole batch can be refused (over quota, collection deleting). Stop
        // rather than hammer the remaining batches into the same wall, and say
        // exactly how much landed so a retry can be trimmed.
        const msg = err instanceof Error ? err.message : String(err)
        ui.error(`Batch ${index + 1} of ${batches.length} was refused: ${msg}`)
        ui.hint(`${added} record(s) were written before this batch.`)
        process.exit(1)
      }
      if (batches.length > 1) {
        ui.step(`${Math.min((index + 1) * BATCH_SIZE, ops.length)}/${ops.length}`)
      }
    }

    ui.success(`Imported ${added} record(s) into ${collectionName} (${describeScope(scope)}).`)
    if (failures.length) {
      ui.error(`${failures.length} record(s) were rejected:`)
      for (const f of failures.slice(0, 10)) ui.hint(`${f.key}: ${f.reason}`)
      if (failures.length > 10) ui.hint(`…and ${failures.length - 10} more`)
    }
    if (errors.length) ui.warn(`${errors.length} line(s) were skipped (see the warnings above).`)
    if (failures.length || errors.length) process.exitCode = 1
  })
}

/** Read the item value from a positional arg, --data, --file, or stdin. */
async function resolveItemValue(
  positional: string | undefined,
  opts: { data?: string; file?: string }
): Promise<unknown> {
  const sources = [
    positional !== undefined ? "a value argument" : null,
    opts.data !== undefined ? "--data" : null,
    opts.file !== undefined ? "--file" : null,
  ].filter(Boolean) as string[]

  if (sources.length > 1) {
    fail(`Pass the value once. Got ${sources.join(" and ")}.`)
  }
  if (opts.data !== undefined) {
    try {
      return parseStrictJson(opts.data, "--data")
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  }
  if (opts.file !== undefined) {
    let raw: string
    try {
      raw = await readFile(opts.file, "utf8")
    } catch (err) {
      fail(`Could not read ${opts.file}: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
    try {
      return parseStrictJson(raw, opts.file)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  }
  if (positional === "-") {
    return parseLooseValue(await readStdin())
  }
  if (positional === undefined) {
    fail(
      "Pass the value as an argument, --data '<json>', --file <path>, or '-' to read stdin.\n" +
        `  Example: ${cli("memory collection set prefs theme dark")}\n` +
        `  Or:      cat item.json | ${cli("memory collection set prefs theme -")}`
    )
  }
  return parseLooseValue(positional!)
}

/** The item table shared by `list` and `query`. */
function printItems(
  items: CollectionItem[],
  nextCursor: string | null | undefined,
  collection: string
) {
  if (items.length === 0) {
    ui.info("No items.")
    return
  }
  ui.table(
    items.map((item) => ({
      key: item.key,
      value: previewValue(item.value),
      rev: String(item.rev),
      expires: item.expiresAt ?? "—",
    }))
  )
  if (nextCursor) {
    ui.hint(`More: --cursor ${nextCursor}`)
    ui.hint(`Everything at once: ${cli(`memory collection export ${collection}`)}`)
  }
}

// --- Usage -----------------------------------------------------------------------

interface MemoryUsage {
  monthKey?: string
  tier?: string
  units?: number
  reads?: number
  writes?: number
  memAdds?: number
  memSearches?: number
  capReached?: boolean
  /** Null on a tier with no cap, in which case only the count is shown. */
  quotaUnits?: number | null
  memoryBytes?: number
  /** Null on a tier with no cap. */
  quotaStorageGB?: number | null
}

function attachUsage(parent: Command, apiFactory: () => Promise<ApiClient>) {
  parent
    .command("usage")
    .description("This month's Memory usage against the plan's quota.")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      const api = await apiFactory()
      try {
        const res = await api.get<{ usage: MemoryUsage }>(`${BASE}/usage`)
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        const u = res.usage ?? {}
        const quotaBytes =
          typeof u.quotaStorageGB === "number" ? u.quotaStorageGB * 1024 ** 3 : undefined

        ui.info(
          `Memory usage${u.monthKey ? ` for ${u.monthKey}` : ""}${u.tier ? ` (${u.tier})` : ""}`
        )
        ui.table([
          { metric: "units", used: formatQuota(u.units, u.quotaUnits) },
          {
            metric: "storage",
            used:
              quotaBytes === undefined
                ? formatBytes(u.memoryBytes ?? 0)
                : `${formatBytes(u.memoryBytes ?? 0)} / ${u.quotaStorageGB} GB (${Math.round(((u.memoryBytes ?? 0) / quotaBytes) * 100)}%)`,
          },
          { metric: "reads", used: formatCount(u.reads) },
          { metric: "writes", used: formatCount(u.writes) },
          { metric: "facts remembered", used: formatCount(u.memAdds) },
          { metric: "searches", used: formatCount(u.memSearches) },
        ])
        if (u.capReached) {
          // Reads and deletes keep working; only writes are refused. Saying
          // "over quota" without that distinction sends people looking for an
          // outage.
          ui.warn(
            "The monthly cap is reached: new writes are refused until it resets. Reads and deletes still work."
          )
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}

// --- Confirmation ----------------------------------------------------------------

/**
 * Type the name back before destroying something.
 *
 * Non-interactive callers get no prompt at all: a script that pipes into this
 * would hang on a TTY read, so it must pass `--yes` instead.
 */
async function confirmDestructive(question: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    fail(`${question} Re-run with --yes to confirm (stdin is not a terminal).`)
  }
  const prompts = (await import("prompts")).default
  ui.warn(question)
  const answer = await prompts({
    type: "text",
    name: "confirm",
    message: `Type "${expected}" to confirm:`,
  })
  return answer.confirm === expected
}
