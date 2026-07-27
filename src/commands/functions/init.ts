// `zavu functions init` — scaffold a new function project locally.
//
// Creates the local file tree (index.ts, package.json) and registers the
// function in your Zavu project. Writes the link to `.zavu/config.json` so
// subsequent `zavu deploy` calls know which function to update.

import { Command } from "commander"
import prompts from "prompts"
import { writeFile, mkdir, readdir } from "node:fs/promises"
import { join, basename, resolve } from "node:path"
import { buildClient } from "../../lib/client"
import { writeProjectConfig } from "../../lib/config"
import { ui, fail, cli, extractServerError } from "../../lib/ui"
import { writeTsconfig, RUNTIME_DEV_DEPENDENCY, SCAFFOLD_GITIGNORE, resolveProjectId } from "../../lib/scaffold"
import { TEMPLATES } from "../../templates"

interface InitOpts {
  template?: string
  name?: string
  slug?: string
  dir?: string
  yes?: boolean
  http?: boolean
}

export function functionsInitCommand(): Command {
  return new Command("init")
    .description("Scaffold a new Zavu Function locally and register it.")
    .option("--template <id>", `Template id (one of: ${TEMPLATES.map((t) => t.id).join(", ")})`)
    .option("--name <name>", "Function name")
    .option("--slug <slug>", "URL slug (lowercase, hyphenated)")
    .option("--dir <path>", "Directory to scaffold into (defaults to ./<slug>)")
    .option("-y, --yes", "Accept defaults, no prompts")
    .option(
      "--http",
      "Expose the function on a public HTTPS URL (for webhooks and tool endpoints)"
    )
    .action(async (opts: InitOpts) => {
      const client = await buildClient()

      const template =
        TEMPLATES.find((t) => t.id === (opts.template ?? "")) ??
        (opts.yes
          ? TEMPLATES[0]
          : await pickTemplate())

      const name =
        opts.name ??
        (opts.yes
          ? template.name
          : (
              await prompts({
                type: "text",
                name: "value",
                message: "Function name:",
                initial: template.name,
                validate: (v: string) => v.trim().length > 0 || "Required",
              })
            ).value)
      if (!name) fail("Name is required.")

      // Default the slug to a slugified version of the name. Falls back to the
      // template's defaultSlug only if the name produces an empty slug (e.g.
      // user typed only emoji or punctuation).
      const slugFromName = slugify(name)
      const defaultSlug = slugFromName || template.defaultSlug
      const slug =
        opts.slug ??
        (opts.yes
          ? defaultSlug
          : (
              await prompts({
                type: "text",
                name: "value",
                message: "URL slug:",
                initial: defaultSlug,
                validate: (v: string) =>
                  /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(v) ||
                  "Lowercase letters, digits, hyphens; 1-50 chars; no leading/trailing hyphen",
              })
            ).value)
      if (!slug) fail("Slug is required.")

      // Note: we resolve the target directory _after_ registration so that
      // any auto-bumped slug (echo → echo-2) ends up in a matching folder
      // when --dir wasn't supplied. The existence check still runs before
      // registration so we don't overwrite local work.
      const initialTargetDir = resolve(opts.dir ?? slug)
      if (await dirHasContents(initialTargetDir)) {
        fail(`Directory ${initialTargetDir} is not empty. Pass --dir <other> or clear it first.`)
      }

      ui.step(`Creating function "${name}" in your Zavu project…`)
      // The CLI uses the SDK's `messages` resource as one example of API
      // access; here we use a direct call until the SDK has a `functions`
      // resource. For now we error out cleanly if the API method isn't there.
      const fnId = await registerFunction(client, {
        name,
        slug,
        template,
        httpEnabled: opts.http,
      })
      if (fnId.slug !== slug) {
        ui.warn(`Slug "${slug}" was taken — used "${fnId.slug}" instead.`)
      }

      // Re-resolve the target dir against the actual slug we got. If --dir
      // was explicit, honor that; otherwise follow the (possibly bumped) slug.
      const targetDir = opts.dir ? resolve(opts.dir) : resolve(fnId.slug)
      if (targetDir !== initialTargetDir && (await dirHasContents(targetDir))) {
        fail(`Directory ${targetDir} is not empty. Pass --dir <other> or clear it first.`)
      }
      ui.step(`Writing files to ${targetDir}…`)
      await mkdir(targetDir, { recursive: true })
      await writeFile(join(targetDir, "index.ts"), template.code, "utf8")
      await writeFile(
        join(targetDir, "package.json"),
        JSON.stringify(
          {
            name: fnId.slug,
            private: true,
            type: "module",
            dependencies: template.dependencies,
            // Provided by the layer in production; declared so the project is
            // workable locally.
            devDependencies: RUNTIME_DEV_DEPENDENCY,
          },
          null,
          2
        ),
        "utf8"
      )
      await writeFile(join(targetDir, ".gitignore"), SCAFFOLD_GITIGNORE, "utf8")
      // Makes the project typecheck and run locally: without this the
      await writeTsconfig(targetDir)

      await writeProjectConfig(
        {
          // See the note in lib/scaffold.ts: /v1/functions does not surface the
          // project, so an empty id here becomes "project_local" at invoke time.
          projectId: fnId.projectId || (await resolveProjectId(client)),
          functionId: fnId.functionId,
          slug: fnId.slug,
          name,
        },
        targetDir
      )

      await ui.scrambleSuccess(`Function "${name}" created.`)
      if (opts.http) {
        // The URL only exists once something is deployed behind it, so say so
        // rather than printing an empty field and letting the caller wonder.
        if (fnId.publicUrl) {
          ui.info(`Public URL: ${fnId.publicUrl}`)
        } else {
          ui.hint("HTTP enabled — the public URL appears after your first deploy.")
        }
      }
      if (template.requiredSecrets.length > 0) {
        ui.info("This template needs the following secrets before its first deploy:")
        for (const s of template.requiredSecrets) {
          ui.hint(`${s.key}  — ${s.hint}`)
        }
        ui.hint(`Set them with \`${cli("fn secrets set <KEY> <value>")}\` or via the dashboard.`)
      }

      ui.info("\nNext steps:")
      ui.hint(`cd ${basename(targetDir)}`)
      // See the note in agents/factory.ts: deploy does not need this, but every
      // local check does, and skipping it looks like a broken tool.
      ui.hint("npm install                          # required for fn invoke + tsc")
      if (template.requiredSecrets.length > 0) {
        for (const s of template.requiredSecrets) {
          ui.hint(cli(`fn secrets set ${s.key} <value>`))
        }
      }
      ui.hint("# edit index.ts")
      ui.hint(cli("deploy"))
    })
}

async function pickTemplate(): Promise<typeof TEMPLATES[number]> {
  const res = await prompts({
    type: "select",
    name: "id",
    message: "Pick a template:",
    choices: TEMPLATES.map((t) => ({
      title: `${t.emoji}  ${t.name}`,
      description: t.summary,
      value: t.id,
    })),
  })
  const found = TEMPLATES.find((t) => t.id === res.id)
  if (!found) fail("No template selected.")
  return found!
}

// Lowercase + ASCII-fold + collapse non-alphanumerics to single hyphens.
// Capped at 20 chars because the server stitches the slug into an AWS Lambda
// function name (`zavu-fn-<projectId32>-<slug>`) that maxes out at 64 chars,
// so the slug ceiling is 23 — leave a 3-char margin for `bumpSlug` collisions.
function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "")
}

/**
 * True when the path exists and holds something.
 *
 * `mkdir my-agent && cd my-agent && zavu init` is the normal way to start, and
 * refusing merely because the directory exists turned that into an error for a
 * folder with nothing to overwrite. Only real contents are a reason to stop.
 */
async function dirHasContents(path: string): Promise<boolean> {
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

async function registerFunction(
  client: import("@zavudev/sdk").default,
  args: {
    name: string
    slug: string
    template: typeof TEMPLATES[number]
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
        sourceCode: args.template.code,
        dependencies: args.template.dependencies,
        // Only sent when asked for. `POST /v1/functions` already accepts it, so
        // exposing a function over HTTP no longer requires a trip to the
        // dashboard — which was the last step in the flow you could not do from
        // a terminal.
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

// Append a `-N` suffix to the base, trimming the base so the resulting slug
// fits within the AWS Lambda name budget (23 chars total, see slugify above).
// Used when the chosen slug is already taken.
function bumpSlug(base: string, n: number): string {
  const SLUG_HARD_MAX = 23
  const suffix = `-${n}`
  const maxBase = SLUG_HARD_MAX - suffix.length
  return base.slice(0, maxBase).replace(/-+$/, "") + suffix
}
