// Pure helpers behind `zavudev memory`, for both halves of it: the facts an
// agent recalls by meaning, and the collections it reads and writes by key.
//
// Everything here is side-effect free so it can be tested without a network or
// a terminal: scope resolution, value parsing, NDJSON framing, and the query
// predicate. The commands themselves stay thin wrappers over the HTTP client.

/** A resolved scope selector. `project` is the default everywhere. */
export type ScopeSelection =
  | { kind: "project" }
  | { kind: "contact" | "conversation"; id: string }

export class ScopeError extends Error {}

/**
 * Resolve the scope from the flags, accepting both spellings.
 *
 * The API asks for the scope two different ways (a `contact:<id>` query param
 * on the collection routes, a `scope` + `contactId` pair in the fact bodies).
 * Making the user learn that split would be leaking our routing into their
 * shell, so both forms are accepted on every command and translated at the
 * call site by `scopeToQuery` / `scopeToBody`.
 */
export function resolveScope(opts: {
  scope?: string
  contact?: string
  conversation?: string
}): ScopeSelection {
  const raw = opts.scope?.trim()

  // Compact form: `contact:<id>` / `conversation:<id>`.
  if (raw && raw.includes(":")) {
    const sep = raw.indexOf(":")
    const kind = raw.slice(0, sep)
    const id = raw.slice(sep + 1).trim()
    if (kind !== "contact" && kind !== "conversation") {
      throw new ScopeError(
        `Unknown scope "${kind}". Use contact:<contactId>, conversation:<conversationId>, or omit --scope for the project.`
      )
    }
    if (!id) throw new ScopeError(`--scope ${kind}:<id> is missing the id.`)
    return { kind, id }
  }

  // Paired form: `--scope contact --contact <id>`.
  const kind = raw && raw.length > 0 ? raw : "project"
  if (kind !== "project" && kind !== "contact" && kind !== "conversation") {
    throw new ScopeError(
      `Unknown scope "${kind}". Use project, contact:<contactId>, or conversation:<conversationId>.`
    )
  }
  if (kind === "project") {
    // An id with no scope is a typo that would otherwise silently write to the
    // project scope, which is the one place the data is hardest to find again.
    if (opts.contact) return { kind: "contact", id: opts.contact }
    if (opts.conversation) return { kind: "conversation", id: opts.conversation }
    return { kind: "project" }
  }
  const id = kind === "contact" ? opts.contact : opts.conversation
  if (!id) {
    throw new ScopeError(
      `--scope ${kind} needs the id too: pass --${kind} <id>, or use --scope ${kind}:<id>.`
    )
  }
  return { kind, id }
}

/** `?scope=` value, or undefined for the project scope (which omits it). */
export function scopeToQuery(scope: ScopeSelection): string | undefined {
  return scope.kind === "project" ? undefined : `${scope.kind}:${scope.id}`
}

/** The `scope` / `contactId` / `conversationId` trio a memory body carries. */
export function scopeToBody(scope: ScopeSelection): Record<string, string> {
  if (scope.kind === "project") return {}
  return {
    scope: scope.kind,
    [scope.kind === "contact" ? "contactId" : "conversationId"]: scope.id,
  }
}

/** How a scope reads in a status line. */
export function describeScope(scope: ScopeSelection): string {
  return scope.kind === "project" ? "project" : `${scope.kind} ${scope.id}`
}

/**
 * Parse a value typed at a shell.
 *
 * Valid JSON is stored as JSON, anything else as a string, so
 * `memory collection set prefs theme dark` does the obvious thing without
 * quoting. The
 * consequence is that `42` lands as a number, which is why every command that
 * uses this prints the resulting type back (see `describeValueType`) rather
 * than leaving the coercion invisible.
 */
export function parseLooseValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "") return raw
  try {
    return JSON.parse(trimmed)
  } catch {
    return raw
  }
}

/** Strict parse for `--data`, where a malformed brace is a mistake, not a string. */
export function parseStrictJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** "string" | "number" | "boolean" | "null" | "array" | "object". */
export function describeValueType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/** `--metadata k=v` pairs into an object. The first `=` splits; later ones are value. */
export function parseMetadataPairs(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const sep = pair.indexOf("=")
    if (sep <= 0) {
      throw new Error(`--metadata expects key=value, got "${pair}".`)
    }
    out[pair.slice(0, sep)] = pair.slice(sep + 1)
  }
  return out
}

export interface QueryWhere {
  field: string
  op: "eq" | "beginsWith" | "between"
  value?: string | number | boolean
  from?: string | number
  to?: string | number
}

/**
 * Build the `where` predicate from the query flags.
 *
 * Exactly one operator is allowed: two would silently drop one, and the result
 * would look like a real answer.
 */
export function buildQueryWhere(opts: {
  field?: string
  eq?: string
  beginsWith?: string
  between?: string[]
}): QueryWhere {
  if (!opts.field) {
    throw new Error("Pass --field <name> to say which indexed field to match.")
  }
  const chosen = [
    opts.eq !== undefined ? "--eq" : null,
    opts.beginsWith !== undefined ? "--begins-with" : null,
    opts.between !== undefined ? "--between" : null,
  ].filter(Boolean) as string[]

  if (chosen.length === 0) {
    throw new Error(
      "Pass one of --eq <value>, --begins-with <prefix>, or --between <from> <to>."
    )
  }
  if (chosen.length > 1) {
    throw new Error(`Pass only one of ${chosen.join(", ")}.`)
  }

  if (opts.eq !== undefined) {
    return { field: opts.field, op: "eq", value: scalarFromFlag(opts.eq, "--eq") }
  }
  if (opts.beginsWith !== undefined) {
    if (opts.beginsWith === "") throw new Error("--begins-with needs a non-empty prefix.")
    return { field: opts.field, op: "beginsWith", value: opts.beginsWith }
  }
  const bounds = opts.between ?? []
  if (bounds.length !== 2) {
    throw new Error("--between takes exactly two values: --between <from> <to>.")
  }
  const from = scalarFromFlag(bounds[0], "--between")
  const to = scalarFromFlag(bounds[1], "--between")
  if (typeof from === "boolean" || typeof to === "boolean") {
    throw new Error("--between takes strings or numbers, not booleans.")
  }
  if (typeof from !== typeof to) {
    // Mixed bounds encode to different key prefixes and match nothing, which
    // reads as "no results" rather than as the mistake it is.
    throw new Error(
      `--between bounds must be the same type: "${bounds[0]}" is a ${typeof from} and "${bounds[1]}" a ${typeof to}.`
    )
  }
  return { field: opts.field, op: "between", from, to }
}

/**
 * A scalar for a query flag. Numbers and booleans are typed, because an
 * indexed value has a type and `--eq 42` against a number field must match.
 * Quote it (`--eq '"42"'`) to force the string.
 */
function scalarFromFlag(raw: string, label: string): string | number | boolean {
  const value = parseLooseValue(raw)
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  throw new Error(`${label} takes a string, number, or boolean, not ${describeValueType(value)}.`)
}

// --- NDJSON import ----------------------------------------------------------

export type BatchOp =
  | { op: "set"; key: string; value: unknown; ttlSeconds?: number }
  | { op: "delete"; key: string }

export interface NdjsonParse {
  ops: BatchOp[]
  /** Lines that could not be turned into an op, with why. */
  errors: Array<{ line: number; reason: string }>
}

/**
 * Turn NDJSON into batch ops.
 *
 * The shape `memory collection export` writes is accepted verbatim: extra fields (`rev`,
 * `createdAt`, `expiresAt`) are ignored so export | import round-trips. A line
 * may also carry `"op": "delete"` to remove a key.
 *
 * Bad lines are collected rather than thrown: a 10,000 line file with one typo
 * on line 4,001 should still import 9,999 records and tell you about the one.
 */
export function parseNdjson(text: string): NdjsonParse {
  const ops: BatchOp[] = []
  const errors: Array<{ line: number; reason: string }> = []

  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (line === "") return
    const lineNo = index + 1

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      errors.push({
        line: lineNo,
        reason: `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      })
      return
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push({ line: lineNo, reason: "expected a JSON object per line" })
      return
    }

    const record = parsed as Record<string, unknown>
    const key = record.key
    if (typeof key !== "string" || key === "") {
      errors.push({ line: lineNo, reason: "missing a string 'key'" })
      return
    }
    if (record.op === "delete") {
      ops.push({ op: "delete", key })
      return
    }
    if (!("value" in record)) {
      errors.push({ line: lineNo, reason: `'${key}' has no 'value'` })
      return
    }
    const ttl = record.ttlSeconds
    if (ttl !== undefined && (typeof ttl !== "number" || !Number.isInteger(ttl))) {
      errors.push({ line: lineNo, reason: `'${key}' has a non-integer ttlSeconds` })
      return
    }
    ops.push({
      op: "set",
      key,
      value: record.value,
      ...(typeof ttl === "number" ? { ttlSeconds: ttl } : {}),
    })
  })

  return { ops, errors }
}

/** Fixed-size slices, for the batch endpoint's 25-op ceiling. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be at least 1")
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// --- Formatting -------------------------------------------------------------

/** Bytes as something a person reads, e.g. `1.4 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** `1,204` — thousands separated, for counters that get big. */
export function formatCount(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US")
}

/**
 * `used / quota (37%)`, or just the count when there is no quota.
 *
 * A tier with no cap reports its quota as null, so that has to read as
 * "unlimited" rather than as a division by zero.
 */
export function formatQuota(
  used: number | undefined,
  quota: number | null | undefined
): string {
  const u = typeof used === "number" ? used : 0
  if (typeof quota !== "number" || quota <= 0) return formatCount(u)
  return `${formatCount(u)} / ${formatCount(quota)} (${Math.round((u / quota) * 100)}%)`
}

/** One truncated line of a value, for a table cell. */
export function previewValue(value: unknown, max = 60): string {
  let text: string
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  text = text.replace(/\s+/g, " ")
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}
