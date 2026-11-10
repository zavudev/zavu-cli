import { spawn, type SpawnOptions } from "node:child_process"

export interface BrowserLaunchSpec {
  cmd: string
  args: string[]
  spawnOptions?: SpawnOptions
}

// Windows `cmd /c start` treats `&` as a statement separator. The auth
// URL is `?port=&state=&callback=`, so start only opened `?port=…` and
// the dashboard reported "Missing required parameters (port, state,
// callback)." Pasting the same URL works because the browser is not cmd.
//
// Quote the URL and pass `windowsVerbatimArguments`: Node's default
// argv quoting does not treat `&` as special, and if we embed quotes
// ourselves Node re-escapes them and cmd sees `&` again.
//
// macOS `open` without `-u` can treat `?…` as a document query.
export function browserLaunchSpec(
  platform: NodeJS.Platform,
  url: string
): BrowserLaunchSpec {
  if (platform === "darwin") {
    return { cmd: "open", args: ["-u", url] }
  }
  if (platform === "win32") {
    return {
      cmd: "cmd",
      args: ["/c", "start", '""', `"${url.replace(/"/g, "")}"`],
      spawnOptions: { windowsVerbatimArguments: true },
    }
  }
  return { cmd: "xdg-open", args: [url] }
}

export async function openBrowser(url: string): Promise<void> {
  const { cmd, args, spawnOptions } = browserLaunchSpec(process.platform, url)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
      ...spawnOptions,
    })
    child.on("error", reject)
    child.unref()
    setTimeout(resolve, 50)
  })
}
