// `npx zavudev functions init` — scaffold a new function project locally.
//
// Creates the local file tree (index.ts, package.json) and registers the
// function in your Zavu project. Writes the link to `.zavu/config.json` so
// subsequent `npx zavudev deploy` calls know which function to update.

import { Command } from "commander"
import prompts from "prompts"
import { writeFile, mkdir } from "node:fs/promises"
import { join, basename, resolve } from "node:path"
import { buildClient } from "../../lib/client"
import { writeProjectConfig } from "../../lib/config"
import { ui, fail, cli } from "../../lib/ui"
import { writeTsconfig, RUNTIME_DEV_DEPENDENCY, SCAFFOLD_GITIGNORE, resolveProjectId } from "../../lib/scaffold"
import { registerFunction, slugify, dirHasContents } from "../../lib/registerFunction"
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
        sourceCode: template.code,
        dependencies: template.dependencies,
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

// slugify / dirHasContents / registerFunction moved to lib/registerFunction.ts —
// shared with `zavudev import`, which registers functions the same way.
