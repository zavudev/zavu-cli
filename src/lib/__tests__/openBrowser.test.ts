import { describe, it, expect } from "vitest"
import { browserLaunchSpec } from "../openBrowser"

// `zavu login` prints a URL that works when pasted, but the auto-opened
// tab landed on /cli-auth missing query params:
//   "Missing required parameters (port, state, callback)."
// On Windows, `cmd /c start` splits on unquoted `&`.
// On macOS, `open` treats `?…` as a document query unless we pass `-u`.

const AUTH =
  "https://dashboard.zavu.dev/cli-auth?port=4242&state=abc&callback=http%3A%2F%2F127.0.0.1%3A4242%2Fcallback&label=Zavu+CLI+on+host"

describe("browserLaunchSpec", () => {
  it("forces macOS open to treat the argument as a URL", () => {
    const spec = browserLaunchSpec("darwin", AUTH)
    expect(spec.cmd).toBe("open")
    expect(spec.args).toContain("-u")
    expect(spec.args.at(-1)).toBe(AUTH)
    expect(spec.args.filter((a) => a.includes("?")).length).toBe(1)
  })

  it("does not let Windows start split on &", () => {
    // THE regression. `cmd /c start "" https://…?port=1&state=2` runs
    // `state=2` as a second command, so the browser only gets `?port=1`.
    // Node's default argv quoting does not treat `&` as special, so the
    // URL must be quoted and passed verbatim.
    const spec = browserLaunchSpec("win32", AUTH)
    expect(spec.cmd).toBe("cmd")
    expect(spec.spawnOptions?.windowsVerbatimArguments).toBe(true)
    expect(spec.args.slice(0, 3)).toEqual(["/c", "start", '""'])
    const urlArg = spec.args[3]
    expect(urlArg.startsWith('"')).toBe(true)
    expect(urlArg.endsWith('"')).toBe(true)
    expect(urlArg).toContain("&state=")
    expect(urlArg).toContain("&callback=")
  })

  it("passes the full URL as a single xdg-open argument", () => {
    const spec = browserLaunchSpec("linux", AUTH)
    expect(spec.cmd).toBe("xdg-open")
    expect(spec.args).toEqual([AUTH])
  })
})
