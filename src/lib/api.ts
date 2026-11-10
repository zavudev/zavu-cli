// Authenticated HTTP client for endpoints the SDK hasn't generated yet.
// Stainless-generated `@zavudev/sdk` only covers a subset of the OpenAPI spec
// (messages, templates, senders, contacts, broadcasts, introspect at time of
// writing). The CLI mirrors the full spec, so for everything else we hit the
// REST API directly with the same Bearer token saved by `npx zavudev login`.
//
// Use the SDK when it has the method (richer types). Use this when it doesn't.

import kleur from "kleur"
import { resolveCredentials } from "./config"
import { fail, ui } from "./ui"

/** Extras a call may need beyond a path and a body. */
export interface RequestOptions {
  query?: Record<string, unknown>
  /** Extra request headers, e.g. `If-Match` for a conditional write. */
  headers?: Record<string, string>
}

/** A non-2xx answer. `status` and `body` let a command handle a specific one. */
export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message)
  }
}

export interface ApiClient {
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<T>
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>
  patch<T = unknown>(path: string, body?: unknown): Promise<T>
  del<T = unknown>(path: string, opts?: RequestOptions): Promise<T>
  baseUrl: string
}

/**
 * Render the per-field validation errors the API already sends back.
 *
 * Without this, a schema mistake surfaces as a bare "Invalid request body" and
 * the developer is left guessing which field, while the response body was
 * naming it exactly. That guessing was measured at roughly a third of a
 * first-session's time, and it is the single cheapest thing to give back.
 *
 * Shape (see the API's `Error` schema): `details.errors[] = { path, message }`.
 * Falls back to compact JSON so an unrecognised `details` still reaches the
 * user instead of being dropped.
 */
export function formatErrorDetails(parsed: unknown): string {
  const details = (parsed as any)?.details
  if (!details) return ""

  const errors = details.errors
  // An empty `errors` array says nothing, and falling through to the JSON
  // dump below would print a bare `{"errors":[]}` under the message.
  if (Array.isArray(errors) && errors.length === 0) return ""
  if (Array.isArray(errors)) {
    const lines = errors.map((e: any) => {
      const path = Array.isArray(e?.path) ? e.path.join(".") : e?.path
      const message = e?.message ?? JSON.stringify(e)
      return path ? `  ${path}: ${message}` : `  ${message}`
    })
    return `\n${lines.join("\n")}`
  }

  try {
    const json = JSON.stringify(details)
    // A blank object carries nothing; don't add a line for it.
    return json && json !== "{}" ? `\n  ${json}` : ""
  } catch {
    return ""
  }
}

export async function buildApi(): Promise<ApiClient> {
  const creds = await resolveCredentials()
  if (!creds?.apiKey) {
    fail(
      "Not logged in. Run `npx zavudev login`, or set ZAVUDEV_API_KEY for a non-interactive environment.",
    )
  }
  const apiKey = creds!.apiKey
  const baseUrl = creds!.apiBaseUrl.replace(/\/$/, "")
  warnIfNotProduction(baseUrl)

  async function request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<T> {
    const url = new URL(path, baseUrl + "/")
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null || v === "") continue
        url.searchParams.set(k, String(v))
      }
    }
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    if (res.status === 204) return undefined as T
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    if (!res.ok) {
      const msg =
        (parsed as any)?.message ||
        (parsed as any)?.error?.message ||
        `${res.status} ${res.statusText}`
      const code = (parsed as any)?.code ? ` [${(parsed as any).code}]` : ""
      throw new ApiRequestError(`${msg}${code}${formatErrorDetails(parsed)}`, res.status, parsed)
    }
    return parsed as T
  }

  return {
    baseUrl,
    get: (p, q) => request("GET", p, { query: q }),
    post: (p, b, o) => request("POST", p, { body: b, ...o }),
    put: (p, b, o) => request("PUT", p, { body: b, ...o }),
    patch: (p, b) => request("PATCH", p, { body: b }),
    del: (p, o) => request("DELETE", p, o),
  }
}

/** Printed at most once per process — a banner on every call would be noise. */
let announcedNonProd = false

/**
 * Say out loud when the CLI is not talking to the production API.
 *
 * `npx zavudev login` stores whichever base URL it was pointed at, and a credential
 * left over from a dev deployment is invisible afterwards: every command
 * succeeds, against the wrong backend. That produced a full round of "the API
 * does not support this" reports where the feature was live in production the
 * whole time and the CLI was querying a stale dev instance.
 *
 * `whoami` already prints the URL, but nobody runs `whoami` before each
 * command. This costs one dim line and makes the mistake self-evident.
 */
function warnIfNotProduction(baseUrl: string): void {
  if (announcedNonProd) return
  if (/^https:\/\/api\.zavu\.dev$/i.test(baseUrl)) return
  announcedNonProd = true
  // stderr, not stdout: this line is for the human, and on stdout it lands
  // inside `--json` output, so every script that pipes a command into a JSON
  // parser breaks the moment it points somewhere other than production.
  process.stderr.write(`  ${kleur.gray(`↯ using ${baseUrl} (not the production API)`)}\n`)
}
