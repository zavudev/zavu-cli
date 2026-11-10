// The eve → Zavu translation layer, embedded as a source string.
//
// When `zavudev deploy` finds an eve-layout project (`agent/instructions.md`),
// it writes this module to `.zavu/eve-compat.ts` and aliases every `eve` import
// in the user's code to it. The user's tool files then execute against Zavu's
// registry (`@zavudev/functions`) without a single edit to their source.
//
// Why a string and not a package: the CLI ships as one self-contained binary,
// and the deployed runtime layer cannot be assumed to carry a compat module —
// bundling the layer into the function's own source is the only path that
// works on every layer version already in production.
//
// Constraints on the embedded code:
// - No backticks and no `${` — it lives inside a template literal here.
// - Imports only `@zavudev/functions` and `zod` (both provided by the runtime
//   layer and marked external by the Build Worker).
// - The Zod→JSON Schema conversion is self-contained: the layer ships zod v3,
//   which has no `toJSONSchema`, and the user's zod resolves to the layer's
//   copy at runtime anyway. The walker reads zod v3 (`_def`) and v4
//   (`_zod.def`) internals for the schema shapes tools actually use.

export const EVE_COMPAT_FILENAME = "eve-compat.ts"

// ---------------------------------------------------------------------------
// The agent-config contract, shared by the static scan and the runtime.
//
// This is an ALLOW-list, and that direction is the whole point. A deny-list of
// "keys we know we drop" makes silence the default: every capability eve adds
// after this file was written passes through unmentioned, and the agent ships
// missing something its author declared. Listing what we DO translate inverts
// that — an unrecognized key is reported by name, so the failure mode is a
// noisy warning instead of a feature that quietly never existed.
//
// Adding a key here is a promise that the adapter reads it. Do not add one
// without the translation to go with it.
// ---------------------------------------------------------------------------

/** Keys of an eve `defineAgent({...})` config the Zavu adapter actually reads. */
export const EVE_SUPPORTED_AGENT_KEYS = ["model", "name"] as const

/**
 * Extra context for keys we can say something concrete and true about. Keys
 * absent from this map still warn — with the generic message that names them,
 * which is the guarantee. These hints only make the common cases actionable.
 *
 * Every hint states a fact about ZAVU (what we do or do not offer), never a
 * claim about eve's semantics, which we cannot verify from here.
 */
export const EVE_AGENT_KEY_HINTS: Record<string, string> = {
  voice:
    "this agent deploys as TEXT ONLY and will not answer phone calls; Zavu voice is configured on a Zavu-native agent (defineAgent with a voice block) or from the dashboard",
  tools: "tools come from agent/tools/*.ts on Zavu, one file per tool",
  instructions: "the system prompt comes from agent/instructions.md",
  prompt: "the system prompt comes from agent/instructions.md",
  skills: "skill files are not loaded at runtime; fold the content into instructions.md",
  outputSchema: "Zavu agents reply with text; ask for the shape you want in instructions.md",
  compaction: "Zavu trims context by message count instead (contextWindowMessages)",
  temperature: "sampling options are not translated; set them on a Zavu-native agent",
  maxTokens: "sampling options are not translated; set them on a Zavu-native agent",
  build: "build hooks do not run on Zavu; dependencies are installed server-side",
}

/** The warning text for one unsupported agent-config key. Past or future tense. */
export function eveAgentKeyWarning(key: string, tense: "will" | "was"): string {
  const verb = tense === "will" ? "will be ignored" : "was ignored"
  const hint = EVE_AGENT_KEY_HINTS[key]
  const base = "agent config '" + key + "' is not translated to Zavu and " + verb
  return hint ? base + " — " + hint : base
}

export interface EveAgentConfigEntry {
  key: string
  /** Present when the value is a plain string literal, e.g. `name: "Aurora"`. */
  stringValue?: string
}

const IDENT_START = /[A-Za-z_$]/
const IDENT_CHAR = /[A-Za-z0-9_$]/

/** Advance past whitespace and comments. */
function skipTrivia(src: string, i: number): number {
  for (;;) {
    if (i >= src.length) return i
    const c = src[i]
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++
      continue
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i += 2
      continue
    }
    return i
  }
}

/** Advance past a string or template literal that starts at `i`. */
function skipString(src: string, i: number): number {
  const quote = src[i]
  i++
  while (i < src.length) {
    const c = src[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      // An interpolation can hold braces and nested strings of its own.
      let depth = 1
      i += 2
      while (i < src.length && depth > 0) {
        const d = src[i]
        if (d === '"' || d === "'" || d === "`") {
          i = skipString(src, i)
          continue
        }
        if (d === "{") depth++
        if (d === "}") depth--
        i++
      }
      continue
    }
    // An unterminated single-line string: bail rather than eat the file.
    if (quote !== "`" && c === "\n") return i
    i++
  }
  return i
}

function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(["'`\\nrt])/g, (_m, c: string) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c
  )
}

/** Index of the `{` opening the agent config object, or -1. */
function findAgentConfigStart(src: string): number {
  let i = 0
  let lastWord = ""
  let prevWord = ""
  while (i < src.length) {
    i = skipTrivia(src, i)
    if (i >= src.length) break
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i)
      prevWord = lastWord
      lastWord = ""
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i
      while (j < src.length && IDENT_CHAR.test(src[j])) j++
      prevWord = lastWord
      lastWord = src.slice(i, j)
      i = j
      continue
    }
    if (c === "(" && lastWord === "defineAgent") {
      const k = skipTrivia(src, i + 1)
      // `defineAgent(someVariable)` is opaque to a static scan; the runtime
      // check still sees the real object.
      return src[k] === "{" ? k : -1
    }
    if (c === "{" && lastWord === "default" && prevWord === "export") {
      return i
    }
    prevWord = lastWord
    lastWord = ""
    i++
  }
  return -1
}

/**
 * Best-effort static read of the top-level keys in `agent/agent.ts`.
 *
 * Deliberately a scanner and not a parser: it exists so the compatibility
 * report is complete BEFORE anything is uploaded. The runtime check inside the
 * compat layer sees the evaluated object and is the authoritative one; this
 * only ever fails by reporting less, never by inventing a key.
 */
export function extractEveAgentConfigEntries(source: string): EveAgentConfigEntry[] {
  const open = findAgentConfigStart(source)
  if (open < 0) return []
  const entries: EveAgentConfigEntry[] = []
  let i = open + 1
  let depth = 1 // brace depth relative to the config object
  let nested = 0 // ( and [ depth, so array/call contents are never read as keys
  let expectKey = true

  const readValue = (from: number): string | undefined => {
    const at = skipTrivia(source, from)
    const q = source[at]
    if (q !== '"' && q !== "'" && q !== "`") return undefined
    const end = skipString(source, at)
    const raw = source.slice(at + 1, end - 1)
    if (q === "`" && raw.includes("${")) return undefined
    return unescapeLiteral(raw)
  }

  while (i < source.length && depth > 0) {
    i = skipTrivia(source, i)
    if (i >= source.length) break
    const c = source[i]
    const atTop = depth === 1 && nested === 0

    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(source, i)
      if (expectKey && atTop && c !== "`") {
        const after = skipTrivia(source, end)
        if (source[after] === ":") {
          const key = unescapeLiteral(source.slice(i + 1, end - 1))
          const stringValue = readValue(after + 1)
          entries.push(stringValue === undefined ? { key } : { key, stringValue })
          expectKey = false
        }
      }
      i = end
      continue
    }
    if (c === "{") {
      depth++
      i++
      continue
    }
    if (c === "}") {
      depth--
      i++
      continue
    }
    if (c === "(" || c === "[") {
      nested++
      i++
      continue
    }
    if (c === ")" || c === "]") {
      nested--
      i++
      continue
    }
    if (c === "," && atTop) {
      expectKey = true
      i++
      continue
    }
    if (expectKey && atTop && IDENT_START.test(c)) {
      let j = i
      while (j < source.length && IDENT_CHAR.test(source[j])) j++
      const key = source.slice(i, j)
      const after = skipTrivia(source, j)
      const punct = source[after]
      // `key: value`, shorthand `key,` / `key}`, or a method `key() {}`.
      if (punct === ":" || punct === "," || punct === "}" || punct === "(") {
        const stringValue = punct === ":" ? readValue(after + 1) : undefined
        entries.push(stringValue === undefined ? { key } : { key, stringValue })
        expectKey = false
      }
      i = j
      continue
    }
    // A spread, a decorator, anything else: not a key we can name.
    expectKey = false
    i++
  }
  return entries
}

/** Warnings for every declared key the adapter does not translate. */
export function eveAgentConfigWarnings(
  entries: EveAgentConfigEntry[],
  tense: "will" | "was"
): string[] {
  const supported = new Set<string>(EVE_SUPPORTED_AGENT_KEYS)
  const seen = new Set<string>()
  const out: string[] = []
  for (const { key } of entries) {
    if (supported.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(eveAgentKeyWarning(key, tense))
  }
  return out
}

/** The declared agent name, trimmed and capped to the API's 100-char limit. */
export function eveDeclaredAgentName(entries: EveAgentConfigEntry[]): string | undefined {
  const raw = entries.find((e) => e.key === "name")?.stringValue?.trim()
  return raw ? raw.slice(0, 100) : undefined
}

// ---------------------------------------------------------------------------
// What makes a file under agent/tools/ an actual tool.
//
// The registration below accepts one thing: a default export carrying the
// marker that defineTool() returns. Counting .ts files instead let the report
// promise tools that reconcile then never created — the file was there, the
// marker was not, and the only trace was a stderr line nobody saw. The two
// criteria have to be the same one.
//
// Biased AGAINST false positives on purpose: dropping a tool that would have
// worked is far worse than missing a warning, so a shape we cannot read with
// certainty is classified "indirect", kept, and left to the runtime check.
// ---------------------------------------------------------------------------

export type EveToolExportShape =
  /** `export default defineTool({...})`. Registers. */
  | "define-tool"
  /** A default export that is a plain object literal. Cannot carry the marker. */
  | "plain-object"
  /** A class, function, array, or primitive. Cannot carry the marker either. */
  | "unsupported-export"
  /** No default export at all. Nothing to register. */
  | "missing"
  /** Some other expression. May well be a tool; only the runtime can tell. */
  | "indirect"

/** Words that, right after `export default`, settle the question on their own. */
const NON_TOOL_KEYWORDS = new Set([
  "class",
  "function",
  "async",
  "true",
  "false",
  "null",
  "undefined",
])

/** Index of the `}` closing the block opened at `open`. */
function findMatchingBrace(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i)
      continue
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipTrivia(src, i)
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return src.length - 1
}

/**
 * Does this object literal spread something in at its top level?
 *
 * `{ ...defineTool({...}) }` copies the marker across and really is a tool, so
 * a spread is the one thing that stops a literal from being a definite answer.
 * Nothing else a literal can contain will produce the marker.
 */
function objectLiteralHasSpread(src: string, open: number, close: number): boolean {
  let i = open + 1
  let depth = 0
  let nested = 0
  while (i < close) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i)
      continue
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipTrivia(src, i)
      continue
    }
    if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === "(" || c === "[") nested++
    else if (c === ")" || c === "]") nested--
    else if (c === "." && depth === 0 && nested === 0 && src.startsWith("...", i)) {
      return true
    }
    i++
  }
  return false
}

function classifyDefaultExpression(src: string, from: number): EveToolExportShape {
  const at = skipTrivia(src, from)
  if (at >= src.length) return "missing"
  const c = src[at]
  if (c === "{") {
    return objectLiteralHasSpread(src, at, findMatchingBrace(src, at))
      ? "indirect"
      : "plain-object"
  }
  // An array or a primitive literal: never a tool.
  if (c === "[" || c === '"' || c === "'" || c === "`" || /[0-9]/.test(c)) {
    return "unsupported-export"
  }
  if (IDENT_START.test(c)) {
    let j = at
    while (j < src.length && IDENT_CHAR.test(src[j])) j++
    const word = src.slice(at, j)
    if (word === "defineTool" && src[skipTrivia(src, j)] === "(") return "define-tool"
    // `export default class` / `function` / `async function` / a primitive
    // keyword: defineTool returns a plain object, so none of these can be one.
    if (NON_TOOL_KEYWORDS.has(word)) return "unsupported-export"
  }
  // An identifier, a call to a user's own wrapper, a re-export: all can carry
  // the marker at runtime.
  return "indirect"
}

/** How a tool file provides its default export, read statically. */
export function classifyEveToolExport(source: string): EveToolExportShape {
  let i = 0
  let lastWord = ""
  while (i < source.length) {
    i = skipTrivia(source, i)
    if (i >= source.length) break
    const c = source[i]
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(source, i)
      lastWord = ""
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i
      while (j < source.length && IDENT_CHAR.test(source[j])) j++
      const word = source.slice(i, j)
      if (word === "default" && lastWord === "export") {
        return classifyDefaultExpression(source, j)
      }
      lastWord = word
      i = j
      continue
    }
    // `export { tool as default }` / `export { default } from "./shared"`.
    if (c === "{" && lastWord === "export") {
      const end = findMatchingBrace(source, i)
      if (/\bdefault\b/.test(source.slice(i + 1, end))) return "indirect"
      i = end + 1
      lastWord = ""
      continue
    }
    lastWord = ""
    i++
  }
  return "missing"
}

/**
 * Why a tool file will not become a tool, or undefined when it will (or when
 * the shape is one only the runtime can judge).
 */
export function eveToolFileWarning(file: string, shape: EveToolExportShape): string | undefined {
  if (shape === "missing") {
    return (
      "tool file " +
      file +
      " skipped: it has no default export, so it will NOT become a tool — a tool file must 'export default defineTool({ ... })'"
    )
  }
  if (shape === "plain-object") {
    return (
      "tool file " +
      file +
      " skipped: its default export is a plain object, not defineTool({ ... }), so it will NOT become a tool — wrap it in defineTool from 'eve/tools'"
    )
  }
  if (shape === "unsupported-export") {
    return (
      "tool file " +
      file +
      " skipped: its default export is not defineTool({ ... }), so it will NOT become a tool — wrap it in defineTool from 'eve/tools'"
    )
  }
  return undefined
}

export const EVE_COMPAT_SOURCE = `// Generated by zavudev — do not edit.
// Maps eve's authoring API (defineTool / defineAgent / …) onto Zavu Functions.
import { defineAgent as __zavuDefineAgent, defineTool as __zavuDefineTool } from "@zavudev/functions"

const __warnings: string[] = []
function __warn(msg: string): void {
  __warnings.push(msg)
  console.warn("[eve-compat] " + msg)
}
export function __getEveCompatWarnings(): string[] {
  return __warnings.slice()
}

// ---------------------------------------------------------------------------
// Zod → JSON Schema. Self-contained on purpose: works against whatever zod
// version the runtime resolves, without toJSONSchema.
// ---------------------------------------------------------------------------
type AnyRecord = Record<string, any>

function __zodInfo(s: any): { v: 3 | 4; def: AnyRecord } | null {
  if (s && typeof s === "object") {
    if (s._zod && s._zod.def) return { v: 4, def: s._zod.def }
    if (s._def) return { v: 3, def: s._def }
  }
  return null
}

function __zodTypeName(info: { v: 3 | 4; def: AnyRecord }): string {
  if (info.v === 4) return String(info.def.type || "")
  return String(info.def.typeName || "").replace(/^Zod/, "").toLowerCase()
}

function __zodShape(info: { v: 3 | 4; def: AnyRecord }): AnyRecord {
  const raw = info.def.shape
  const shape = typeof raw === "function" ? raw() : raw
  return shape && typeof shape === "object" ? shape : {}
}

function __isOptionalLike(s: any): boolean {
  let cur = s
  for (let i = 0; i < 10; i++) {
    const info = __zodInfo(cur)
    if (!info) return false
    const t = __zodTypeName(info)
    if (t === "optional" || t === "default") return true
    if (t === "effects" || t === "pipe" || t === "readonly" || t === "catch") {
      cur = info.def.schema || info.def.innerType || info.def.in
      continue
    }
    return false
  }
  return false
}

function __describe(s: any, out: AnyRecord): AnyRecord {
  const info = __zodInfo(s)
  const desc =
    (info && typeof info.def.description === "string" && info.def.description) ||
    (typeof s.description === "string" && s.description) ||
    undefined
  if (desc) out.description = desc
  return out
}

function __zodToJsonSchema(s: any, path: string): AnyRecord {
  const info = __zodInfo(s)
  if (!info) {
    __warn(path + ": unrecognized schema node; emitting a permissive schema")
    return {}
  }
  const t = __zodTypeName(info)
  const def = info.def
  switch (t) {
    case "object": {
      const shape = __zodShape(info)
      const properties: AnyRecord = {}
      const required: string[] = []
      for (const key of Object.keys(shape)) {
        properties[key] = __zodToJsonSchema(shape[key], path + "." + key)
        if (!__isOptionalLike(shape[key])) required.push(key)
      }
      const out: AnyRecord = { type: "object", properties }
      if (required.length > 0) out.required = required
      return __describe(s, out)
    }
    case "string": {
      const out: AnyRecord = { type: "string" }
      const checks = Array.isArray(def.checks) ? def.checks : []
      for (const c of checks) {
        const kind = c && (c.kind || (c._zod && c._zod.def && c._zod.def.check))
        if (kind === "min" || kind === "min_length") out.minLength = c.value ?? (c._zod && c._zod.def && c._zod.def.minimum)
        if (kind === "max" || kind === "max_length") out.maxLength = c.value ?? (c._zod && c._zod.def && c._zod.def.maximum)
        if (kind === "email") out.format = "email"
        if (kind === "url") out.format = "uri"
        if (kind === "regex" && c.regex) out.pattern = String(c.regex.source || c.regex)
      }
      return __describe(s, out)
    }
    case "number": {
      const out: AnyRecord = { type: "number" }
      const checks = Array.isArray(def.checks) ? def.checks : []
      for (const c of checks) {
        const kind = c && (c.kind || (c._zod && c._zod.def && c._zod.def.check))
        if (kind === "int" || kind === "number_format") out.type = "integer"
        if (kind === "min" || kind === "greater_than") out.minimum = c.value ?? (c._zod && c._zod.def && c._zod.def.value)
        if (kind === "max" || kind === "less_than") out.maximum = c.value ?? (c._zod && c._zod.def && c._zod.def.value)
      }
      return __describe(s, out)
    }
    case "int":
      return __describe(s, { type: "integer" })
    case "boolean":
      return __describe(s, { type: "boolean" })
    case "date":
      return __describe(s, { type: "string", format: "date-time" })
    case "array": {
      const inner = def.type || def.element
      return __describe(s, { type: "array", items: inner ? __zodToJsonSchema(inner, path + "[]") : {} })
    }
    case "enum": {
      const values = Array.isArray(def.values)
        ? def.values
        : def.entries && typeof def.entries === "object"
          ? Object.values(def.entries)
          : []
      return __describe(s, { type: "string", enum: values })
    }
    case "nativeenum": {
      const values = def.values && typeof def.values === "object" ? Object.values(def.values) : []
      return __describe(s, { enum: values })
    }
    case "literal": {
      const value = def.value !== undefined ? def.value : Array.isArray(def.values) ? def.values[0] : undefined
      return __describe(s, { const: value })
    }
    case "union": {
      const options = Array.isArray(def.options) ? def.options : []
      return __describe(s, { anyOf: options.map((o: any, i: number) => __zodToJsonSchema(o, path + "|" + i)) })
    }
    case "record": {
      const valueType = def.valueType || def.valueSchema
      return __describe(s, {
        type: "object",
        additionalProperties: valueType ? __zodToJsonSchema(valueType, path + ".*") : true,
      })
    }
    case "optional":
    case "readonly":
      return __zodToJsonSchema(def.innerType, path)
    case "default": {
      const inner = __zodToJsonSchema(def.innerType, path)
      try {
        const dv = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue
        if (dv !== undefined) inner.default = dv
      } catch {
        // A throwing default factory is not worth failing the schema over.
      }
      return inner
    }
    case "nullable": {
      const inner = __zodToJsonSchema(def.innerType, path)
      return { anyOf: [inner, { type: "null" }] }
    }
    case "effects":
    case "pipe":
    case "catch":
      return __zodToJsonSchema(def.schema || def.innerType || def.in, path)
    case "any":
    case "unknown":
      return {}
    default: {
      __warn(path + ": zod type '" + t + "' has no JSON Schema mapping; emitting a permissive schema")
      return {}
    }
  }
}

function __looksLikeJsonSchema(s: any): boolean {
  return (
    s &&
    typeof s === "object" &&
    !__zodInfo(s) &&
    typeof s.safeParse !== "function" &&
    (s.type !== undefined || s.properties !== undefined || s.anyOf !== undefined || s.oneOf !== undefined)
  )
}

export function __toJsonSchema(schema: any, ctxName: string): AnyRecord {
  if (schema === undefined || schema === null) return { type: "object", properties: {} }
  if (__looksLikeJsonSchema(schema)) return schema
  if (__zodInfo(schema)) {
    const out = __zodToJsonSchema(schema, ctxName)
    if (out.type !== "object") {
      throw new Error(
        ctxName + ": inputSchema must be an object schema (z.object({...}) or a JSON Schema with type 'object')"
      )
    }
    return out
  }
  if (schema && typeof schema === "object" && schema["~standard"]) {
    throw new Error(
      ctxName +
        ": Standard Schema inputs other than Zod are not supported on Zavu yet — pass a Zod object schema or a plain JSON Schema object"
    )
  }
  throw new Error(ctxName + ": unsupported inputSchema — pass a Zod object schema or a plain JSON Schema object")
}

// ---------------------------------------------------------------------------
// eve authoring API. Tool/agent definitions are captured as markers; the
// generated entry registers them with their path-derived names.
// ---------------------------------------------------------------------------
export interface EveToolSpec {
  description?: string
  inputSchema?: any
  outputSchema?: any
  approval?: any
  toModelOutput?: any
  execute: (input: any, ctx: any) => any
}

export function defineTool(spec: EveToolSpec): { __eveTool: true; spec: EveToolSpec } {
  if (!spec || typeof spec.execute !== "function") {
    throw new Error("defineTool: an execute(input, ctx) function is required")
  }
  return { __eveTool: true, spec }
}

export function defineAgent(config: AnyRecord): { __eveAgent: true; config: AnyRecord } {
  return { __eveAgent: true, config: config || {} }
}

export function __registerEveTool(name: string, mod: any): void {
  const marker = mod && mod.__eveTool ? mod : mod && mod.default && mod.default.__eveTool ? mod.default : null
  if (!marker) {
    __warn("tool '" + name + "' does not default-export defineTool({...}) — skipped")
    return
  }
  const spec: EveToolSpec = marker.spec
  if (spec.approval !== undefined) {
    __warn("tool '" + name + "': approval gates are not supported on Zavu yet — the tool runs WITHOUT approval")
  }
  if (spec.toModelOutput !== undefined) {
    __warn("tool '" + name + "': toModelOutput is ignored on Zavu — the raw return value is sent to the model")
  }
  const parameters = __toJsonSchema(spec.inputSchema, "tool '" + name + "'")
  __zavuDefineTool({
    name,
    description: String(spec.description || name),
    parameters,
    handler: async (args: any, zctx: any) => {
      const ctx = {
        session: {
          id: zctx && zctx.sessionId,
          messageId: zctx && zctx.messageId,
          contactPhone: zctx && zctx.contactPhone,
        },
        toolName: name,
        callId: zctx && zctx.messageId,
        abortSignal: new AbortController().signal,
        log: (zctx && zctx.log) || console.log,
        getSandbox(): never {
          throw new Error(
            "getSandbox() is not available on Zavu. Run this agent on eve's own runtime with the Zavu channel if it needs a sandbox."
          )
        },
        getSkill(): never {
          throw new Error(
            "getSkill() is not available on Zavu. Skill files are not loaded at runtime; move required content into the tool or the agent instructions."
          )
        },
      }
      return spec.execute(args, ctx)
    },
  })
}

// ALLOW-list: the only agent-config keys this adapter reads. Anything else the
// project declares is reported by name below. Kept in step with
// EVE_SUPPORTED_AGENT_KEYS / EVE_AGENT_KEY_HINTS in the CLI module that embeds
// this source; a test asserts the two copies agree.
const SUPPORTED_AGENT_KEYS = ["model", "name"]

const AGENT_KEY_HINTS: AnyRecord = {
  voice:
    "this agent deploys as TEXT ONLY and will not answer phone calls; Zavu voice is configured on a Zavu-native agent (defineAgent with a voice block) or from the dashboard",
  tools: "tools come from agent/tools/*.ts on Zavu, one file per tool",
  instructions: "the system prompt comes from agent/instructions.md",
  prompt: "the system prompt comes from agent/instructions.md",
  skills: "skill files are not loaded at runtime; fold the content into instructions.md",
  outputSchema: "Zavu agents reply with text; ask for the shape you want in instructions.md",
  compaction: "Zavu trims context by message count instead (contextWindowMessages)",
  temperature: "sampling options are not translated; set them on a Zavu-native agent",
  maxTokens: "sampling options are not translated; set them on a Zavu-native agent",
  build: "build hooks do not run on Zavu; dependencies are installed server-side",
}

export function __registerEveAgent(
  agentConfig: any,
  extra: { name: string; prompt: string; senderId?: string }
): void {
  const cfg: AnyRecord =
    agentConfig && agentConfig.__eveAgent
      ? agentConfig.config
      : agentConfig && agentConfig.default && agentConfig.default.__eveAgent
        ? agentConfig.default.config
        : agentConfig && typeof agentConfig === "object"
          ? agentConfig
          : {}
  for (const key of Object.keys(cfg)) {
    if (SUPPORTED_AGENT_KEYS.indexOf(key) !== -1) continue
    const hint = AGENT_KEY_HINTS[key]
    __warn(
      "agent config '" + key + "' is not translated to Zavu and was ignored" +
        (hint ? " — " + hint : "")
    )
  }
  let model: string | undefined
  if (typeof cfg.model === "string") {
    model = cfg.model
  } else if (cfg.model !== undefined) {
    __warn("non-string model configs (provider instances, defineDynamic) are not supported — using the default model")
  }
  // A declared name wins over the one derived from package.json: it is the
  // author's explicit choice, and on Zavu an agent's name is its display label.
  let name = extra.name
  if (typeof cfg.name === "string" && cfg.name.trim()) {
    name = cfg.name.trim().slice(0, 100)
  } else if (cfg.name !== undefined) {
    __warn("agent config 'name' must be a non-empty string; using '" + extra.name + "' instead")
  }
  __zavuDefineAgent({
    senderId: extra.senderId || undefined,
    name: name,
    provider: "zavu",
    model: model || "anthropic/claude-sonnet-5",
    prompt: extra.prompt,
    channels: ["*"],
  })
}

// ---------------------------------------------------------------------------
// Stubs for eve surfaces that have no Zavu equivalent. They exist so shared
// lib code that imports them still loads; using them warns instead of lying.
// ---------------------------------------------------------------------------
function __stub(surface: string, hint: string) {
  return (..._args: any[]) => {
    __warn(surface + " is not supported on Zavu — " + hint)
    return { __eveUnsupported: surface }
  }
}

export const defineSkill = __stub("defineSkill", "skills are not loaded at runtime; fold the content into instructions.md")
export const defineChannel = __stub(
  "defineChannel",
  "Zavu's senders ARE the channels; messaging arrives without a channel file"
)
export const defineSchedule = __stub("defineSchedule", "use a Zavu cron trigger instead (fn triggers add --events cron)")
export const defineOpenAPIConnection = __stub(
  "defineOpenAPIConnection",
  "connections are not supported; call the API from a tool handler instead"
)
export const defineMCPConnection = __stub("defineMCPConnection", "MCP connections are not supported on Zavu")
export const GET = __stub("channel route GET()", "channel routes never run on Zavu")
export const POST = __stub("channel route POST()", "channel routes never run on Zavu")
export const WS = __stub("channel route WS()", "channel routes never run on Zavu")
export const always = () => ({ __eveApproval: "always" })
export const once = () => ({ __eveApproval: "once" })
export const never = () => ({ __eveApproval: "never" })
`
