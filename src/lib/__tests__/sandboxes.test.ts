import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PROJECT_WEBHOOK_EVENTS, buildCreateBody, parseEnv, parseMetadata, parseTimeout, SandboxFlagError } from "../sandboxes"

// A flag read wrong starts a machine with the wrong settings, and a start is
// billed: these are checked before anything reaches the API.

describe("parseEnv", () => {
  it("splits on the first = only, so values may contain one", () => {
    expect(parseEnv(["DATABASE_URL=postgres://u:p@db/app?ssl=true", "EMPTY="])).toEqual({
      DATABASE_URL: "postgres://u:p@db/app?ssl=true",
      EMPTY: "",
    })
  })

  it("returns undefined when no flag is given", () => {
    expect(parseEnv(undefined)).toBeUndefined()
    expect(parseEnv([])).toBeUndefined()
  })

  it("refuses a missing key, an invalid key and a repeated key", () => {
    expect(() => parseEnv(["=x"])).toThrow(SandboxFlagError)
    expect(() => parseEnv(["NOEQUALS"])).toThrow(SandboxFlagError)
    expect(() => parseEnv(["1BAD=x"])).toThrow(/Invalid --env key/)
    expect(() => parseEnv(["A=1", "A=2"])).toThrow(/more than once/)
  })
})

describe("parseMetadata", () => {
  it("accepts the API's key characters", () => {
    expect(parseMetadata(["job.id:1=42"])).toEqual({ "job.id:1": "42" })
  })

  it("refuses a key starting with a separator", () => {
    expect(() => parseMetadata(["-job=1"])).toThrow(/Invalid --metadata key/)
  })
})

describe("parseTimeout", () => {
  it("maps --no-timeout to null and an absent flag to undefined", () => {
    expect(parseTimeout(false)).toBeNull()
    expect(parseTimeout(true)).toBeUndefined()
    expect(parseTimeout(undefined)).toBeUndefined()
  })

  it("accepts 60 to 86400 whole seconds only", () => {
    expect(parseTimeout("600")).toBe(600)
    expect(() => parseTimeout("59")).toThrow(SandboxFlagError)
    expect(() => parseTimeout("86401")).toThrow(SandboxFlagError)
    expect(() => parseTimeout("90.5")).toThrow(SandboxFlagError)
    expect(() => parseTimeout("ten")).toThrow(SandboxFlagError)
  })
})

describe("buildCreateBody", () => {
  it("sends only what was given", () => {
    expect(buildCreateBody({ timeout: true })).toEqual({})
  })

  it("maps every flag to its API field", () => {
    expect(
      buildCreateBody(
        {
          size: "small",
          timeout: "1800",
          ephemeral: true,
          name: "preview",
          env: ["A=1"],
          environment: "staging",
          from: "zsh_abc",
          metadata: ["job=build-1"],
          idempotencyKey: "k1",
        },
        "npm install\n"
      )
    ).toEqual({
      size: "small",
      timeoutSeconds: 1800,
      ephemeral: true,
      name: "preview",
      env: { A: "1" },
      environment: "staging",
      from: "zsh_abc",
      metadata: { job: "build-1" },
      idempotencyKey: "k1",
      setupScript: "npm install\n",
    })
  })

  it("sends timeoutSeconds null for --no-timeout", () => {
    expect(buildCreateBody({ timeout: false })).toEqual({ timeoutSeconds: null })
  })

  it("refuses an unknown size", () => {
    expect(() => buildCreateBody({ size: "huge" })).toThrow(/--size/)
  })
})

// `project-webhook set --help` lists these. A list behind the API's hides an
// event nobody then subscribes to.
describe("PROJECT_WEBHOOK_EVENTS", () => {
  it("matches the API's ProjectWebhookEvent", () => {
    const spec = JSON.parse(readFileSync(join(__dirname, "../../../../../apps/docs/openapi.json"), "utf8"))
    expect([...PROJECT_WEBHOOK_EVENTS].sort()).toEqual(
      [...spec.components.schemas.ProjectWebhookEvent.enum].sort()
    )
  })
})
