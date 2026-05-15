// Authenticated HTTP client for endpoints the SDK hasn't generated yet.
// Stainless-generated `@zavudev/sdk` only covers a subset of the OpenAPI spec
// (messages, templates, senders, contacts, broadcasts, introspect at time of
// writing). The CLI mirrors the full spec, so for everything else we hit the
// REST API directly with the same Bearer token saved by `zavu login`.
//
// Use the SDK when it has the method (richer types). Use this when it doesn't.

import { readCredentials } from "./config"
import { fail } from "./ui"

export interface ApiClient {
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<T>
  post<T = unknown>(path: string, body?: unknown): Promise<T>
  patch<T = unknown>(path: string, body?: unknown): Promise<T>
  del<T = unknown>(path: string): Promise<T>
  baseUrl: string
}

export async function buildApi(): Promise<ApiClient> {
  const creds = await readCredentials()
  if (!creds?.apiKey) {
    fail("Not logged in. Run `zavu login` first.")
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
      throw new Error(`${msg}${code}`)
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
