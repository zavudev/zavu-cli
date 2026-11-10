// Registering a function against the API, shared by `functions init`,
// `agents pull`-adjacent flows, and `zavudev import`. Extracted from init.ts
// so the import command cannot drift from the scaffold flow.

import { readdir } from "node:fs/promises"
import { extractServerError, fail } from "./ui"

// Lowercase + ASCII-fold + collapse non-alphanumerics to single hyphens.
// Capped at 20 chars because the server stitches the slug into an AWS Lambda
// function name (`zavu-fn-<projectId32>-<slug>`) that maxes out at 64 chars,
// so the slug ceiling is 23 — leave a 3-char margin for `bumpSlug` collisions.
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "")
}

// Append a `-N` suffix to the base, trimming the base so the resulting slug
// fits within the AWS Lambda name budget (23 chars total, see slugify above).
// Used when the chosen slug is already taken.
export function bumpSlug(base: string, n: number): string {
  const SLUG_HARD_MAX = 23
  const suffix = `-${n}`
  const maxBase = SLUG_HARD_MAX - suffix.length
  return base.slice(0, maxBase).replace(/-+$/, "") + suffix
}

/**
 * True when the path exists and holds something.
 *
 * `mkdir my-agent && cd my-agent && npx zavudev init` is the normal way to start, and
 * refusing merely because the directory exists turned that into an error for a
 * folder with nothing to overwrite. Only real contents are a reason to stop.
 */
export async function dirHasContents(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path)
    return entries.length > 0
  } catch (err) {
    // ENOENT: nothing there, which is fine. ENOTDIR: a file sits in the way,
    // and that is a genuine collision.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    return true
  }
}

/**
 * Name and slug for a project being registered from a directory that already
 * holds code — `deploy`'s first-deploy path, where nobody was ever asked.
 *
 * Precedence is explicit flag, then what the project already calls itself, then
 * the directory. An npm package name can be scoped (`@acme/returns-agent`) or
 * hold characters a slug cannot, so the slug is always derived rather than
 * reused, and it can come back empty for a name with no ASCII alphanumerics at
 * all — the caller has to handle that instead of registering an unnamed thing.
 */
export function deriveFunctionIdentity(args: {
  flagName?: string
  flagSlug?: string
  pkgName?: string
  dirName: string
}): { name: string; slug: string } {
  const name = args.flagName ?? args.pkgName ?? args.dirName
  return { name, slug: args.flagSlug ?? slugify(name) }
}

// Registers the function via the API. The SDK doesn't expose a `functions`
// resource yet (the dashboard uses internal Convex mutations), so we hit the
// public HTTP endpoint directly. When Stainless adds Functions to the OpenAPI
// spec, replace this with `client.functions.create({...})`.
//
// Slug conflicts: if the chosen slug is taken we automatically retry with
// `slug-2`, `slug-3`, … up to MAX_SLUG_ATTEMPTS. Bumping is silent at the API
// layer; the caller compares the returned slug against what it requested and
// shows a `ui.warn` if they differ.
const MAX_SLUG_ATTEMPTS = 25

export async function registerFunction(
  client: { baseURL: string; apiKey: string },
  args: {
    name: string
    slug: string
    /** The project tree, keyed by path relative to the project root. */
    files?: Record<string, string>
    entrypoint?: string
    /** Single-file form, for callers that produce one module (the eve compiler). */
    sourceCode?: string
    dependencies: Record<string, string>
    httpEnabled?: boolean
  }
): Promise<{
  projectId: string
  functionId: string
  slug: string
  publicUrl: string | null
}> {
  let attempt = 0
  let candidateSlug = args.slug
  while (true) {
    attempt += 1
    const res = await fetch(`${client.baseURL}/v1/functions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${client.apiKey}`,
      },
      body: JSON.stringify({
        name: args.name,
        slug: candidateSlug,
        ...(args.files ? { files: args.files } : {}),
        ...(args.entrypoint ? { entrypoint: args.entrypoint } : {}),
        ...(args.sourceCode !== undefined ? { sourceCode: args.sourceCode } : {}),
        dependencies: args.dependencies,
        // Only sent when asked for. `POST /v1/functions` already accepts it, so
        // exposing a function over HTTP no longer requires a trip to the
        // dashboard.
        ...(args.httpEnabled ? { httpEnabled: true } : {}),
      }),
    })

    if (res.ok) {
      const json = (await res.json()) as {
        function?: { id: string; slug: string; publicUrl?: string | null }
      }
      const fn = json.function
      if (!fn?.id) {
        fail("Server returned a malformed function payload.")
      }
      return {
        projectId: "", // not surfaced by /v1/functions yet — implicit from the API key
        functionId: fn!.id,
        slug: fn!.slug,
        publicUrl: fn!.publicUrl ?? null,
      }
    }

    // Read body once. We need it both to detect slug conflicts (retry) and
    // to surface a clean error message on actual failures.
    const text = await res.text().catch(() => "")
    const isSlugConflict = /already exists/i.test(text) && /slug/i.test(text)
    if (isSlugConflict && attempt < MAX_SLUG_ATTEMPTS) {
      candidateSlug = bumpSlug(args.slug, attempt + 1)
      continue
    }
    // Build a fake Response so we can reuse the standard error extractor.
    const errMsg = await extractServerError(
      new Response(text, { status: res.status }),
      `Failed to register function (${res.status})`
    )
    fail(errMsg)
  }
}
