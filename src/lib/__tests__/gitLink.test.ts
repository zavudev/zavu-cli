// Parsing the repository argument of `fn git link`.
//
// This is the first thing the command touches and the only part that can fail
// without a round-trip, so it takes whatever a developer actually has in the
// clipboard: the owner/repo pair, the URL from the address bar, or the remote
// that `git remote -v` prints.

import { describe, it, expect, vi, afterEach } from "vitest"
import { parseRepoArg } from "../../commands/functions/git"

// `fail` exits the process. Trade it for a throw so the rejection paths are
// assertable instead of killing the test run.
vi.mock("../ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui")>()
  return {
    ...actual,
    fail: (msg: string) => {
      throw new Error(msg)
    },
  }
})

afterEach(() => vi.clearAllMocks())

describe("parseRepoArg", () => {
  it("reads owner/repo", () => {
    expect(parseRepoArg("acme/support-bot")).toEqual({ owner: "acme", repo: "support-bot" })
  })

  it("reads an https URL from the address bar", () => {
    expect(parseRepoArg("https://github.com/acme/support-bot")).toEqual({
      owner: "acme",
      repo: "support-bot",
    })
  })

  it("reads an SSH remote", () => {
    expect(parseRepoArg("git@github.com:acme/support-bot.git")).toEqual({
      owner: "acme",
      repo: "support-bot",
    })
  })

  it("drops a trailing .git", () => {
    expect(parseRepoArg("https://github.com/acme/support-bot.git").repo).toBe("support-bot")
  })

  it("tolerates surrounding whitespace, which pasting adds", () => {
    expect(parseRepoArg("  acme/support-bot  ")).toEqual({ owner: "acme", repo: "support-bot" })
  })

  it("keeps dots and underscores, which are legal in a repo name", () => {
    expect(parseRepoArg("acme/support.bot_v2").repo).toBe("support.bot_v2")
  })

  it("rejects a bare name, rather than guessing the owner", () => {
    expect(() => parseRepoArg("support-bot")).toThrow(/owner\/repo/)
  })

  it("rejects a URL that is not GitHub", () => {
    expect(() => parseRepoArg("https://gitlab.com/acme/support-bot")).toThrow(/owner\/repo/)
  })

  it("rejects an empty string", () => {
    expect(() => parseRepoArg("   ")).toThrow(/Could not read/)
  })
})
