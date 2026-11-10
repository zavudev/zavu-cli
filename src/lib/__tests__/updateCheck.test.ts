import { describe, it, expect } from "vitest"
import { isOutdated } from "../updateCheck"

describe("isOutdated", () => {
  it("flags the gap that went unnoticed for months", () => {
    // A deprecated install path served 0.5.0 while npm was on 0.9.4, and
    // nothing told the user. This is the case the check exists for.
    expect(isOutdated("0.5.0", "0.9.4")).toBe(true)
  })

  it("is quiet when current", () => {
    expect(isOutdated("0.9.4", "0.9.4")).toBe(false)
  })

  it("is quiet when ahead of the registry", () => {
    // Local builds run a version that is not published yet. Telling someone to
    // "upgrade" to an older release would be worse than saying nothing.
    expect(isOutdated("0.9.5", "0.9.4")).toBe(false)
  })

  it("compares numerically, not as strings", () => {
    // "0.10.0" < "0.9.0" lexicographically, which is the classic way this
    // check ends up silent exactly when it matters.
    expect(isOutdated("0.9.0", "0.10.0")).toBe(true)
    expect(isOutdated("0.10.0", "0.9.0")).toBe(false)
  })

  it("tolerates prerelease and v-prefixed tags", () => {
    expect(isOutdated("v0.9.0", "0.9.1")).toBe(true)
    expect(isOutdated("0.9.0-beta.1", "0.9.0")).toBe(false)
  })

  it("does not warn on malformed input", () => {
    expect(isOutdated("", "")).toBe(false)
    expect(isOutdated("unknown", "unknown")).toBe(false)
  })
})
