import { describe, it, expect, afterEach, vi } from "vitest"
import { formatErrorDetails } from "../api"
import { isInteractive } from "../ui"

// Two output bugs cost a first-time user roughly a third of their session, and
// neither was visible from inside a terminal — which is why they survived.
// These are pure, so they are cheap to keep honest.

describe("formatErrorDetails", () => {
  it("names the offending field and why", () => {
    // The API already sends this. Dropping it left "Invalid request body" and
    // a developer guessing at a JSON shape nothing documents.
    expect(
      formatErrorDetails({
        code: "invalid_request",
        details: {
          errors: [
            { path: ["steps", 0, "nextStepId"], message: "Expected string, received null" },
          ],
        },
      }),
    ).toBe("\n  steps.0.nextStepId: Expected string, received null")
  })

  it("lists every error, not just the first", () => {
    const out = formatErrorDetails({
      details: {
        errors: [
          { path: ["name"], message: "Required" },
          { path: ["model"], message: "Required" },
        ],
      },
    })
    expect(out.split("\n").filter(Boolean)).toHaveLength(2)
  })

  it("handles an error with no path", () => {
    expect(formatErrorDetails({ details: { errors: [{ message: "Too many items" }] } })).toBe(
      "\n  Too many items",
    )
  })

  it("falls back to compact JSON for an unrecognised details shape", () => {
    // Better a blob than silently discarding what the server tried to say.
    expect(formatErrorDetails({ details: { retryAfter: 30 } })).toBe('\n  {"retryAfter":30}')
  })

  it("adds nothing when there is nothing to add", () => {
    expect(formatErrorDetails({ code: "not_found" })).toBe("")
    expect(formatErrorDetails({ details: {} })).toBe("")
    expect(formatErrorDetails({ details: { errors: [] } })).toBe("")
    expect(formatErrorDetails(undefined)).toBe("")
    expect(formatErrorDetails("plain text body")).toBe("")
  })
})

describe("isInteractive", () => {
  const realIsTTY = process.stdout.isTTY
  const realCI = process.env.CI
  const realNoAnimate = process.env.ZAVU_NO_ANIMATE

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: realIsTTY, configurable: true, writable: true,
    })
    if (realCI === undefined) delete process.env.CI
    else process.env.CI = realCI
    if (realNoAnimate === undefined) delete process.env.ZAVU_NO_ANIMATE
    else process.env.ZAVU_NO_ANIMATE = realNoAnimate
  })

  const setTTY = (value: unknown) =>
    Object.defineProperty(process.stdout, "isTTY", {
      value, configurable: true, writable: true,
    })

  it("stays off when stdout is a pipe", () => {
    // THE regression. Node reports `undefined` — not false — for a pipe, so an
    // `?? true` fallback turned the animation on for CI logs and for every
    // coding agent reading our output.
    delete process.env.CI
    delete process.env.ZAVU_NO_ANIMATE
    setTTY(undefined)
    expect(isInteractive()).toBe(false)
  })

  it("stays off when stdout is explicitly not a TTY", () => {
    delete process.env.CI
    delete process.env.ZAVU_NO_ANIMATE
    setTTY(false)
    expect(isInteractive()).toBe(false)
  })

  it("is on for a real terminal", () => {
    delete process.env.CI
    delete process.env.ZAVU_NO_ANIMATE
    setTTY(true)
    expect(isInteractive()).toBe(true)
  })

  it("stays off in CI even on a TTY", () => {
    delete process.env.ZAVU_NO_ANIMATE
    setTTY(true)
    process.env.CI = "1"
    expect(isInteractive()).toBe(false)
  })

  it("honours the opt-out", () => {
    delete process.env.CI
    setTTY(true)
    process.env.ZAVU_NO_ANIMATE = "1"
    expect(isInteractive()).toBe(false)
  })
})

// The docs promised ZAVUDEV_API_KEY as the CI escape hatch for a long time and
// only `login` read it — so a container, a CI job, or a coding agent with no
// writable home hit "Not logged in" on every command. Making the docs true is
// what lets anything headless authenticate.
describe("credential resolution", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    vi.resetModules()
  })

  it("uses ZAVUDEV_API_KEY, so no saved file is needed", async () => {
    vi.resetModules()
    process.env.ZAVUDEV_API_KEY = "zv_live_fromenv"
    delete process.env.ZAVUDEV_API_BASE_URL

    const { resolveCredentials } = await import("../config")
    const creds = await resolveCredentials()

    expect(creds?.apiKey).toBe("zv_live_fromenv")
    // Defaults to production, so a bare key is enough in CI.
    expect(creds?.apiBaseUrl).toBe("https://api.zavu.dev")
  })

  it("honours a base-url override, so it can point at a non-prod deployment", async () => {
    vi.resetModules()
    process.env.ZAVUDEV_API_KEY = "zv_live_x"
    process.env.ZAVUDEV_API_BASE_URL = "https://example.convex.site"

    const { resolveCredentials } = await import("../config")
    expect((await resolveCredentials())?.apiBaseUrl).toBe("https://example.convex.site")
  })

  it("never authenticates with a blank key", async () => {
    vi.resetModules()
    process.env.ZAVUDEV_API_KEY = "   "

    const { resolveCredentials } = await import("../config")
    const creds = await resolveCredentials()

    // Whitespace must fall through to the saved file (or to null), never be
    // sent as a Bearer token — that fails as a confusing 401 instead of a
    // clear "not logged in".
    expect(creds?.apiKey ?? "").not.toBe("   ")
    expect((creds?.apiKey ?? "").trim()).not.toBe("")
  })
})
