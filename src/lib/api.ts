// Authenticated HTTP client for endpoints the SDK hasn't generated yet.
// Stainless-generated `@zavudev/sdk` only covers a subset of the OpenAPI spec
// (messages, templates, senders, contacts, broadcasts, introspect at time of
// writing). The CLI mirrors the full spec, so for everything else we hit the
// REST API directly with the same Bearer token saved by `zavu login`.
//
// Use the SDK when it has the method (richer types). Use this when it doesn't.

import { resolveCredentials } from "./config"
import { fail } from "./ui"

export interface ApiClient {
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<T>
  post<T = unknown>(path: string, body?: unknown): Promise<T>
  patch<T = unknown>(path: string, body?: unknown): Promise<T>
  del<T = unknown>(path: string): Promise<T>
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
      "Not logged in. Run `zavu login`, or set ZAVUDEV_API_KEY for a non-interactive environment.",
    )
  }
  const apiKey = creds!.apiKey
  const baseUrl = creds!.apiBaseUrl.replace(/\/$/, "")

  async function request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown } = {}
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
      throw new Error(`${msg}${code}${formatErrorDetails(parsed)}`)
    }
    return parsed as T
  }

  return {
    baseUrl,
    get: (p, q) => request("GET", p, { query: q }),
    post: (p, b) => request("POST", p, { body: b }),
    patch: (p, b) => request("PATCH", p, { body: b }),
    del: (p) => request("DELETE", p),
  }
}
