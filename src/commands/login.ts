// `npx zavudev login` — browser-based authentication.
//
// Flow (default):
//   1. CLI starts a tiny HTTP server on a random localhost port.
//   2. CLI opens https://dashboard.zavu.dev/cli-auth?port=PORT&state=STATE
//      in the user's browser.
//   3. Browser: user signs in with Clerk, picks a project, clicks
//      "Authorize Zavu CLI". The dashboard creates a fresh API key labeled
//      "Zavu CLI on <hostname>" and redirects the browser to
//      http://127.0.0.1:PORT/callback?token=KEY&state=STATE.
//   4. CLI verifies the state, saves credentials, and shows success.
//
// Fallbacks:
//   --api-key zv_live_…   Skip the browser entirely (CI / scripts / power users).
//   --no-browser           Print the URL but don't try to open it.
//   --dashboard <url>      Override the dashboard origin (staging / self-host).

import { Command } from "commander"
import { createServer } from "node:http"
import { hostname } from "node:os"
import Zavudev from "@zavudev/sdk"
import {
  writeCredentials,
  readCredentials,
  credentialsPath,
} from "../lib/config"
import { openBrowser } from "../lib/openBrowser"
import { ui, fail, cli } from "../lib/ui"

// Defaults point at production, but env vars override so a developer running
// the dashboard locally can do:
//   export ZAVU_DASHBOARD_URL=http://localhost:3000
// and then `npx zavudev login` Just Works against their dev stack. The dashboard
// page also reports its own API origin back through the callback (see
// `apiBaseUrl` query param below), so once the user picks the right
// dashboard, the matching API URL is auto-discovered.
const DEFAULT_DASHBOARD_URL =
  process.env.ZAVU_DASHBOARD_URL || "https://dashboard.zavu.dev"
const DEFAULT_API_BASE_URL = process.env.ZAVU_API_URL || "https://api.zavu.dev"
const LOGIN_TIMEOUT_MS = 5 * 60_000

interface LoginOptions {
  apiKey?: string
  baseUrl: string
  dashboard: string
  show?: boolean
  browser: boolean
}

export function loginCommand(): Command {
  return new Command("login")
    .description("Authenticate via your browser. The CLI gets a fresh API key.")
    .option("--api-key <key>", "Skip the browser and save the given API key directly")
    .option("--base-url <url>", "Override the API base URL", DEFAULT_API_BASE_URL)
    .option("--dashboard <url>", "Override the dashboard URL", DEFAULT_DASHBOARD_URL)
    .option("--no-browser", "Don't try to open the browser, just print the URL")
    .option("--show", "Print the credentials path and current login state, then exit")
    .action(async (opts: LoginOptions) => {
      if (opts.show) {
        const existing = await readCredentials()
        ui.info(`Credentials path: ${credentialsPath()}`)
        if (existing) {
          ui.success(`Logged in (key …${existing.apiKey.slice(-4)})`)
        } else {
          ui.warn("Not logged in.")
        }
        return
      }

      // Direct paste mode: skip the whole browser dance.
      const explicitKey = opts.apiKey ?? process.env.ZAVUDEV_API_KEY
      if (explicitKey) {
        ui.brandIntro("Authenticating via direct key…")
        await saveAndVerify(explicitKey, opts.baseUrl)
        return
      }

      // Browser flow — show the brand the moment the user types `npx zavudev login`.
      ui.brandIntro("One API for all your messages.")
      const state = randomToken()
      const result = await startCallbackServerAndWait(state, opts)
      // The dashboard reports its own API origin back through the callback so
      // the saved credentials match whatever stack the user authenticated
      // against (prod vs local dev). If the dashboard didn't include one
      // (older deploy), fall back to --base-url.
      const baseUrl = result.apiBaseUrl ?? opts.baseUrl
      if (result.apiBaseUrl && result.apiBaseUrl !== opts.baseUrl) {
        ui.hint(`Dashboard reported API URL: ${result.apiBaseUrl}`)
      }
      await saveAndVerify(result.token, baseUrl)
    })
}

async function saveAndVerify(apiKey: string, baseUrl: string) {
  if (!apiKey.startsWith("zv_")) {
    fail("API key must start with zv_live_ or zv_test_.")
  }
  await ui.scrambleStep(`Validating against ${baseUrl}…`)
  const client = new Zavudev({ apiKey, baseURL: baseUrl })
  try {
    await client.senders.list({ limit: 1 })
  } catch (err) {
    fail(`API key rejected: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Best-effort context fetch so the success line tells the user which
  // project the key now binds to. If /v1/me isn't deployed yet we silently
  // skip — login still succeeds.
  let project: string | undefined
  let team: string | undefined
  let mode: "test" | "live" | undefined
  try {
    const meRes = await fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${apiKey}` },
    })
    if (meRes.ok) {
      const me = (await meRes.json()) as {
        project?: { name: string | null }
        team?: { name: string | null }
        isTestMode?: boolean
      }
      project = me.project?.name ?? undefined
      team = me.team?.name ?? undefined
      mode = me.isTestMode ? "test" : "live"
    }
  } catch {
    /* non-fatal */
  }

  await writeCredentials({
    apiKey,
    apiBaseUrl: baseUrl,
    updatedAt: new Date().toISOString(),
  })
  // The success line is the moment that matters — give it the decrypt cue.
  await ui.scrambleSuccess(`Logged in.`)
  ui.hint(`Credentials stored at ${credentialsPath()} (mode 0600)`)
  if (project || team) {
    ui.hint(
      `Bound to project "${project ?? "?"}" (team "${team ?? "?"}", ${mode ?? "live"} key)`
    )
    ui.hint(`To switch projects: \`${cli("login")}\` again and pick a different one.`)
  }
}

// Starts an HTTP server on a random localhost port, opens the dashboard auth
// URL, and resolves with the token once the browser hits /callback. Rejects
// on timeout, state mismatch, or explicit error.
async function startCallbackServerAndWait(
  state: string,
  opts: LoginOptions
): Promise<{ token: string; apiBaseUrl?: string }> {
  return new Promise((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    // node:http, not Bun.serve, so the CLI runs under Node via `npx zavu`.
    const server = createServer((req, res) => {
      const sendHtml = (status: number, html: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" })
        res.end(html)
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1")

      if (url.pathname === "/" || url.pathname === "/health") {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("Zavu CLI listening")
        return
      }
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" })
        res.end("Not found")
        return
      }

      const incomingState = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const token = url.searchParams.get("token")
      const apiBaseUrl = url.searchParams.get("apiBaseUrl") ?? undefined

      if (error) {
        finishErr(error)
        sendHtml(400, renderHtml(false, error))
        return
      }
      if (!token) {
        finishErr("Missing token in callback")
        sendHtml(400, renderHtml(false, "Missing token"))
        return
      }
      if (incomingState !== state) {
        finishErr("State mismatch — possible CSRF, ignoring")
        sendHtml(400, renderHtml(false, "State mismatch"))
        return
      }
      finishOk(token, apiBaseUrl)
      sendHtml(200, renderHtml(true))
    })

    server.on("error", (err) => finishErr(err.message))
    // Port 0 → the OS assigns a free port. `address()` is only reliable once
    // the server is actually listening, so open the browser from the callback.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = address && typeof address === "object" ? address.port : 0
      const dashboardUrl = opts.dashboard.replace(/\/$/, "")
      const callbackUrl = `http://127.0.0.1:${port}/callback`
      const params = new URLSearchParams({
        port: String(port),
        state,
        callback: callbackUrl,
        label: `Zavu CLI on ${safeHostname()}`,
      })
      const authUrl = `${dashboardUrl}/cli-auth?${params.toString()}`

      ui.info("Opening browser to authorize the CLI…")
      ui.hint(`If your browser doesn't open, visit:\n  ${authUrl}`)

      if (opts.browser !== false) {
        openBrowser(authUrl).catch(() => {
          ui.warn("Couldn't open the browser automatically. Open the URL above.")
        })
      }
    })

    timeoutHandle = setTimeout(() => {
      finishErr(`Timed out after ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s`)
    }, LOGIN_TIMEOUT_MS)

    function stopServerSoon() {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      // Delay so the browser response actually flushes before the server dies.
      setTimeout(() => {
        try {
          // `close()` only stops NEW connections. The browser holds the
          // callback socket open with keep-alive, and that live handle keeps
          // Node's event loop alive — so login printed "✓ Logged in." and then
          // sat there until the socket timed out, looking hung.
          //
          // Guarded because closeAllConnections landed in Node 18.2; on older
          // 18.x we fall back to unref, which lets the process exit while the
          // socket lingers harmlessly.
          const anyServer = server as unknown as {
            closeAllConnections?: () => void
          }
          if (typeof anyServer.closeAllConnections === "function") {
            anyServer.closeAllConnections()
          } else {
            server.unref()
          }
          server.close()
        } catch {
          /* ignore */
        }
      }, 250)
    }
    function finishOk(token: string, apiBaseUrl?: string) {
      stopServerSoon()
      resolve({ token, apiBaseUrl })
    }
    function finishErr(message: string) {
      stopServerSoon()
      reject(new Error(message))
    }
  })
}

function randomToken(): string {
  // 16 bytes of entropy → 32 hex chars. Plenty for CSRF protection.
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

function safeHostname(): string {
  try {
    return hostname() || "unknown-host"
  } catch {
    return "unknown-host"
  }
}

function renderHtml(ok: boolean, message?: string): string {
  const title = ok ? "You're logged in." : "Login failed."
  const body = ok
    ? "You can close this tab and return to your terminal."
    : `Something went wrong: ${escapeHtml(message ?? "unknown error")}.`
  const accent = ok ? "#22c55e" : "#ef4444"
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Zavu CLI — ${escapeHtml(title)}</title>
<style>
  html,body{margin:0;height:100%;background:#0a0a0a;color:#fafafa;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
  .wrap{display:flex;align-items:center;justify-content:center;height:100%}
  .card{max-width:420px;padding:2.5rem;border:1px solid #262626;border-radius:14px;text-align:center;background:#111}
  .dot{width:42px;height:42px;border-radius:50%;background:${accent};margin:0 auto 1rem;display:flex;align-items:center;justify-content:center;font-size:22px;color:#000;font-weight:700}
  h1{margin:0 0 .5rem;font-size:18px}
  p{margin:.25rem 0;opacity:.7}
  .brand{margin-top:1.5rem;opacity:.4;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
</style>
</head><body><div class="wrap"><div class="card">
<div class="dot">${ok ? "✓" : "!"}</div>
<h1>${escapeHtml(title)}</h1>
<p>${body}</p>
<p class="brand">Zavu CLI</p>
</div></div></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  )
}
