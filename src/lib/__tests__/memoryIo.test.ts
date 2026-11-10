import { describe, it, expect } from "vitest"
import {
  buildQueryWhere,
  chunk,
  describeValueType,
  formatBytes,
  formatQuota,
  parseLooseValue,
  parseMetadataPairs,
  parseNdjson,
  previewValue,
  resolveScope,
  ScopeError,
  scopeToBody,
  scopeToQuery,
} from "../memoryIo"

// The memory commands are thin wrappers over HTTP; everything that can
// silently do the wrong thing lives in these helpers. A scope that resolves to
// the project when the user named a contact writes real data where nobody will
// look for it again, and a query flag coerced to the wrong type returns an
// empty list that reads exactly like an empty collection.

describe("resolveScope", () => {
  it("defaults to the project", () => {
    expect(resolveScope({})).toEqual({ kind: "project" })
    expect(resolveScope({ scope: "project" })).toEqual({ kind: "project" })
    expect(resolveScope({ scope: "  " })).toEqual({ kind: "project" })
  })

  it("accepts the compact form", () => {
    expect(resolveScope({ scope: "contact:abc123" })).toEqual({ kind: "contact", id: "abc123" })
    expect(resolveScope({ scope: "conversation:xyz" })).toEqual({
      kind: "conversation",
      id: "xyz",
    })
  })

  it("accepts the paired form", () => {
    expect(resolveScope({ scope: "contact", contact: "abc123" })).toEqual({
      kind: "contact",
      id: "abc123",
    })
  })

  it("uses an id passed on its own rather than silently writing to the project", () => {
    // `--contact x` with no --scope is unambiguous about intent, and defaulting
    // to the project would put the data somewhere the user never looks.
    expect(resolveScope({ contact: "abc123" })).toEqual({ kind: "contact", id: "abc123" })
    expect(resolveScope({ conversation: "conv1" })).toEqual({
      kind: "conversation",
      id: "conv1",
    })
  })

  it("refuses a named scope with no id", () => {
    expect(() => resolveScope({ scope: "contact" })).toThrow(ScopeError)
    expect(() => resolveScope({ scope: "contact:" })).toThrow(/missing the id/)
  })

  it("refuses a scope kind that does not exist", () => {
    expect(() => resolveScope({ scope: "team:abc" })).toThrow(/Unknown scope/)
    expect(() => resolveScope({ scope: "sender" })).toThrow(/Unknown scope/)
  })

  it("translates to whichever shape the endpoint wants", () => {
    // The collection routes take ?scope=contact:<id>; the fact bodies take a
    // scope + contactId pair. Same flags, two wire formats.
    const contact = resolveScope({ scope: "contact:c1" })
    expect(scopeToQuery(contact)).toBe("contact:c1")
    expect(scopeToBody(contact)).toEqual({ scope: "contact", contactId: "c1" })

    const conversation = resolveScope({ scope: "conversation:v1" })
    expect(scopeToBody(conversation)).toEqual({ scope: "conversation", conversationId: "v1" })

    // Project is the default on both sides, so it sends nothing.
    expect(scopeToQuery({ kind: "project" })).toBeUndefined()
    expect(scopeToBody({ kind: "project" })).toEqual({})
  })
})

describe("parseLooseValue", () => {
  it("keeps unquoted words as strings", () => {
    expect(parseLooseValue("dark")).toBe("dark")
    expect(parseLooseValue("hello world")).toBe("hello world")
  })

  it("parses JSON when it is JSON", () => {
    expect(parseLooseValue('{"a":1}')).toEqual({ a: 1 })
    expect(parseLooseValue("[1,2]")).toEqual([1, 2])
    expect(parseLooseValue("42")).toBe(42)
    expect(parseLooseValue("true")).toBe(true)
    expect(parseLooseValue("null")).toBeNull()
  })

  it("does not swallow a broken object into a string", () => {
    // A truncated brace is a typo, but it is also legitimately a string, so it
    // is stored as one. The command prints the resulting type for this reason.
    expect(parseLooseValue('{"a":')).toBe('{"a":')
  })
})

describe("describeValueType", () => {
  it("distinguishes the shapes a user cares about", () => {
    expect(describeValueType("x")).toBe("string")
    expect(describeValueType(1)).toBe("number")
    expect(describeValueType(true)).toBe("boolean")
    expect(describeValueType(null)).toBe("null")
    expect(describeValueType([1])).toBe("array")
    expect(describeValueType({})).toBe("object")
  })
})

describe("parseMetadataPairs", () => {
  it("splits on the first = only", () => {
    expect(parseMetadataPairs(["source=crm", "note=a=b"])).toEqual({
      source: "crm",
      note: "a=b",
    })
  })

  it("is undefined when nothing was passed", () => {
    expect(parseMetadataPairs(undefined)).toBeUndefined()
    expect(parseMetadataPairs([])).toBeUndefined()
  })

  it("rejects a pair with no key", () => {
    expect(() => parseMetadataPairs(["=value"])).toThrow(/key=value/)
    expect(() => parseMetadataPairs(["novalue"])).toThrow(/key=value/)
  })
})

describe("buildQueryWhere", () => {
  it("builds each operator", () => {
    expect(buildQueryWhere({ field: "status", eq: "open" })).toEqual({
      field: "status",
      op: "eq",
      value: "open",
    })
    expect(buildQueryWhere({ field: "key", beginsWith: "ORD-" })).toEqual({
      field: "key",
      op: "beginsWith",
      value: "ORD-",
    })
    expect(buildQueryWhere({ field: "date", between: ["2026-01-01", "2026-02-01"] })).toEqual({
      field: "date",
      op: "between",
      from: "2026-01-01",
      to: "2026-02-01",
    })
  })

  it("types the value, because an indexed number is not the string of it", () => {
    expect(buildQueryWhere({ field: "n", eq: "42" }).value).toBe(42)
    expect(buildQueryWhere({ field: "b", eq: "true" }).value).toBe(true)
    // Quoting forces the string back.
    expect(buildQueryWhere({ field: "n", eq: '"42"' }).value).toBe("42")
  })

  it("insists on exactly one operator", () => {
    expect(() => buildQueryWhere({ field: "a" })).toThrow(/--eq/)
    expect(() => buildQueryWhere({ field: "a", eq: "1", beginsWith: "x" })).toThrow(
      /only one/
    )
  })

  it("needs a field", () => {
    expect(() => buildQueryWhere({ eq: "1" })).toThrow(/--field/)
  })

  it("rejects mixed-type between bounds instead of returning nothing", () => {
    // Mixed bounds encode to different key prefixes and match nothing, which
    // is indistinguishable from "no data" at the terminal.
    expect(() => buildQueryWhere({ field: "n", between: ["1", "z"] })).toThrow(
      /same type/
    )
    expect(() => buildQueryWhere({ field: "n", between: ["1"] })).toThrow(/exactly two/)
  })
})

describe("parseNdjson", () => {
  it("round-trips what `memory collection export` writes", () => {
    // Export emits key/value/rev/expiresAt; import has to ignore the fields it
    // cannot send back, or a backup could not be restored.
    const text = [
      JSON.stringify({ key: "a", value: { x: 1 }, rev: 3, expiresAt: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ key: "b", value: "two", rev: 1 }),
    ].join("\n")
    expect(parseNdjson(text)).toEqual({
      ops: [
        { op: "set", key: "a", value: { x: 1 } },
        { op: "set", key: "b", value: "two" },
      ],
      errors: [],
    })
  })

  it("keeps a ttl and honours an explicit delete", () => {
    const text = [
      JSON.stringify({ key: "a", value: 1, ttlSeconds: 600 }),
      JSON.stringify({ key: "b", op: "delete" }),
    ].join("\n")
    expect(parseNdjson(text).ops).toEqual([
      { op: "set", key: "a", value: 1, ttlSeconds: 600 },
      { op: "delete", key: "b" },
    ])
  })

  it("ignores blank lines and a trailing newline", () => {
    const text = `${JSON.stringify({ key: "a", value: 1 })}\n\n  \n`
    const result = parseNdjson(text)
    expect(result.ops).toHaveLength(1)
    expect(result.errors).toEqual([])
  })

  it("keeps importing past a bad line and reports it by number", () => {
    // A typo on one line of a 10,000 line file must not cost the other 9,999.
    const text = [
      JSON.stringify({ key: "a", value: 1 }),
      "{not json",
      JSON.stringify({ key: "c", value: 3 }),
      JSON.stringify({ value: "no key" }),
      JSON.stringify({ key: "e" }),
      JSON.stringify([1, 2]),
    ].join("\n")
    const { ops, errors } = parseNdjson(text)
    expect(ops.map((o) => o.key)).toEqual(["a", "c"])
    expect(errors.map((e) => e.line)).toEqual([2, 4, 5, 6])
    expect(errors[2].reason).toMatch(/no 'value'/)
  })

  it("stores a null value rather than treating it as missing", () => {
    expect(parseNdjson(JSON.stringify({ key: "a", value: null })).ops).toEqual([
      { op: "set", key: "a", value: null },
    ])
  })
})

describe("chunk", () => {
  it("slices to the batch ceiling", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 25)).toEqual([])
    expect(chunk([1], 25)).toEqual([[1]])
  })

  it("refuses a size that would loop forever", () => {
    expect(() => chunk([1], 0)).toThrow()
  })
})

describe("formatting", () => {
  it("scales bytes", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(15 * 1024)).toBe("15 KB")
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB")
  })

  it("shows the share of a quota, and just the count without one", () => {
    expect(formatQuota(250, 1000)).toBe("250 / 1,000 (25%)")
    expect(formatQuota(250, undefined)).toBe("250")
    expect(formatQuota(undefined, 1000)).toBe("0 / 1,000 (0%)")
    // An uncapped tier reports its quota as null, which must read as the count
    // rather than as a division by zero.
    expect(formatQuota(250, null)).toBe("250")
    expect(formatQuota(250, 0)).toBe("250")
  })

  it("keeps a preview to one short line", () => {
    expect(previewValue({ a: 1 })).toBe('{"a":1}')
    expect(previewValue("a\n  b")).toBe("a b")
    expect(previewValue("x".repeat(80)).length).toBe(60)
  })
})
