// Printing the result of `agents tools test`.
//
// The bar is set by the bug this replaces: the endpoint used to answer
// `{"scheduled": true}` whether or not anything ran, and people believed it.
// So a run that failed has to LOOK failed. A tool that answers 404 is a failed
// run even though the API call itself returns 200, and printing both the same
// way is the exact mistake being corrected.

import { describe, it, expect, vi, afterEach } from "vitest"
import { printToolRun } from "../../commands/api/agents"

const success = vi.fn()
const warn = vi.fn()
const info = vi.fn()

vi.mock("../ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui")>()
  return {
    ...actual,
    ui: { ...actual.ui, success: (m: string) => success(m), warn: (m: string) => warn(m), info: (m: string) => info(m) },
    fail: (msg: string) => {
      throw new Error(msg)
    },
  }
})

const written: string[] = []
afterEach(() => {
  success.mockClear()
  warn.mockClear()
  info.mockClear()
  written.length = 0
  vi.restoreAllMocks()
})

function capture() {
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    written.push(String(chunk))
    return true
  }) as never)
}

describe("printToolRun", () => {
  it("reports a successful run with its status and duration", () => {
    capture()
    printToolRun({ success: true, statusCode: 200, durationMs: 163, response: '{"status":"shipped"}' })

    expect(success).toHaveBeenCalledWith(expect.stringContaining("163ms"))
    expect(success).toHaveBeenCalledWith(expect.stringContaining("HTTP 200"))
    expect(warn).not.toHaveBeenCalled()
    expect(written.join("")).toContain('"status":"shipped"')
  })

  it("does not dress a non-2xx up as success", () => {
    // The API call succeeded; the tool did not. This is the distinction the
    // old `{"scheduled": true}` erased.
    capture()
    printToolRun({ success: false, statusCode: 404, durationMs: 261, error: "Webhook returned 404" })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"))
    expect(success).not.toHaveBeenCalled()
    expect(written.join("")).toContain("Webhook returned 404")
  })

  it("says so when the tool never answered at all", () => {
    // DNS failure, timeout, connection refused: there is no status code, and
    // "HTTP undefined" would be worse than saying nothing came back.
    capture()
    printToolRun({ success: false, statusCode: null, durationMs: 5000, error: "getaddrinfo ENOTFOUND" })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no response"))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("undefined"))
  })

  it("refuses to print nothing when the API returned no run", () => {
    expect(() => printToolRun(undefined)).toThrow(/did not return a run/i)
  })
})
