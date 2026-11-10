// `npx zavudev functions deploy` — figure out what kind of project the current
// directory holds, collect its source, and push it to Zavu's deploy pipeline.
//
// Two project formats deploy today:
//   - Zavu native: a root index.ts, plus every file it imports. The tree is
//     uploaded as-is and the server-side Build Worker (esbuild + npm install)
//     resolves the imports between the files and bundles them.
//   - eve layout: agent/instructions.md + agent/tools/*. Compiled client-side
//     into one module (see lib/frameworks.ts) and shipped through the same
//     endpoint — the server cannot tell the difference.

import { Command } from "commander"
import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { buildClient } from "../../lib/client"
import { readProjectConfig, writeProjectConfig } from "../../lib/config"
import { registerFunction, deriveFunctionIdentity } from "../../lib/registerFunction"
import { ui, fail } from "../../lib/ui"
import { deployAndWait } from "../../lib/deployRun"
import { detectFramework, compileEveProject, printEveReport } from "../../lib/frameworks"
import { collectProjectFiles } from "../../lib/projectFiles"

export function functionsDeployCommand(): Command {
  return new Command("deploy")
    .description("Deploy the function in the current directory (Zavu native or eve layout).")
    .option("--source <file>", "Source file relative to cwd", "index.ts")
    .option(
      "--sender <senderId>",
      "Sender the agent answers on (eve projects; inlined at compile time). Falls back to the SENDER_ID secret."
    )
    .option(
      "--update-runtime",
      "Bump this function to the latest runtime layer. Default: keep pinned to the runtime it last deployed against."
    )
    .option(
      "--arch <arch>",
      "CPU architecture: arm64 (default, cheapest) or x86_64 (+25% cost, broader native-module compat)."
    )
    .option(
      "--name <name>",
      "Name for a project being deployed for the first time. Defaults to package.json's name, then the directory name."
    )
    .option("--slug <slug>", "Slug for a project being deployed for the first time. Derived from the name when omitted.")
    .option("--watch", "(future) keep running and redeploy on file changes")
    .action(
      async (opts: {
        source: string
        sender?: string
        name?: string
        slug?: string
        watch?: boolean
        updateRuntime?: boolean
        arch?: string
      }) => {
        if (opts.watch) {
          fail("--watch is not implemented yet. Use `npx zavudev functions invoke` for local iteration.")
        }
        const client = await buildClient()
        const cwd = process.cwd()

        // Read declared dependencies + the optional `zavu` config block from
        // package.json. The server's Build Worker installs the deps; the `zavu`
        // block lets users pin architecture etc. directly in source control.
        let pkgDependencies: Record<string, string> = {}
        let pkgArch: string | undefined
        let pkgName: string | undefined
        try {
          const pkgRaw = await readFile(join(cwd, "package.json"), "utf8")
          const pkg = JSON.parse(pkgRaw) as {
            name?: string
            dependencies?: Record<string, string>
            zavu?: { architecture?: string }
          }
          pkgDependencies = pkg.dependencies ?? {}
          pkgArch = pkg.zavu?.architecture
          pkgName = pkg.name
        } catch {
          // No package.json — fine for templates with zero deps.
        }

        // Format detection. An explicitly passed --source always means the
        // classic single-file flow — never reinterpret what the user named.
        const sourceExplicit = opts.source !== "index.ts"
        const detection = await detectFramework(cwd)

        // What gets uploaded. The eve path compiles to a single module and
        // sends `sourceCode`; the native path sends the tree it walked. The API
        // accepts either.
        let files: Record<string, string> | undefined
        let entrypoint: string | undefined
        let sourceCode: string | undefined
        let dependencies: Record<string, string>

        if (!sourceExplicit && detection.framework === "eve") {
          ui.step(`eve project detected (${detection.evidence}) — compiling…`)
          let compiled
          try {
            compiled = await compileEveProject(cwd, { senderId: opts.sender })
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err))
          }
          printEveReport(compiled!.analysis, { sender: opts.sender })
          sourceCode = compiled!.sourceCode
          dependencies = compiled!.dependencies
        } else {
          // Walk the project from its entrypoint and upload everything it
          // reaches. Files nothing imports (tests, scratch work) stay on your
          // machine.
          let collected
          try {
            collected = await collectProjectFiles(cwd, opts.source)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (message.startsWith("Could not read") && detection.framework === "unknown") {
              fail(
                `Could not read ${opts.source}, and this directory is neither a Zavu function (index.ts) nor an eve project (agent/instructions.md). Pass --source <file> if your entrypoint is named differently.`
              )
            }
            if (message.startsWith("Could not read")) {
              fail(`Could not read ${opts.source}. Pass --source <file> if your entrypoint is named differently.`)
            }
            fail(message)
          }
          files = collected!.files
          entrypoint = collected!.entrypoint
          dependencies = pkgDependencies

          const count = Object.keys(files).length
          if (count > 1) {
            ui.step(`Uploading ${count} files from ${entrypoint}.`)
          }

          // Also send the single-file form when the project IS one file.
          //
          // This CLI is published to npm separately from the API that learned to
          // read `files`, and nothing stops someone upgrading the CLI while
          // pointed at an older deployment. That server would ignore `files`,
          // find no source in the request, and quietly redeploy whatever draft
          // it already had — a green deploy of the wrong code, which is the
          // worst way to fail. Sending both makes the common case survive it.
          // A server that understands `files` prefers it and ignores this.
          //
          // A genuinely multi-file project cannot be expressed to that older
          // server at all, so there is nothing to add here; it fails loudly
          // instead, which is the right outcome.
          if (count === 1) {
            sourceCode = files[entrypoint]
          }
          // Not fatal: an unresolvable import may just be the scanner reading
          // something that is not an import at all. The build says so properly
          // if it was real.
          for (const warning of collected!.warnings) ui.warn(warning)

        }

        // First deploy of a project that exists on disk but not yet in Zavu.
        //
        // `init` scaffolds into an empty directory, so it cannot adopt a project
        // you already wrote — and an eve project you cloned or authored by hand
        // had no door at all: `init` refused the non-empty directory and
        // `import` only speaks GitHub. Registering here closes that gap; the
        // directory is already proven to be a real project by the detection
        // above, which is the only thing registration was ever waiting on.
        let config = await readProjectConfig()
        if (!config) {
          if (detection.framework === "unknown" && !sourceExplicit) {
            fail(
              "This directory is neither a Zavu function (index.ts) nor an eve project (agent/instructions.md). Run `npx zavudev functions init` to start a new one, or `cd` into a function directory."
            )
          }
          const { name, slug: requestedSlug } = deriveFunctionIdentity({
            flagName: opts.name,
            flagSlug: opts.slug,
            pkgName,
            dirName: basename(cwd),
          })
          if (!requestedSlug) {
            fail(`Could not derive a slug from "${name}". Pass --slug <slug>.`)
          }
          ui.step(`First deploy: registering "${name}" in your Zavu project…`)
          const registered = await registerFunction(client, {
            name,
            slug: requestedSlug,
            files,
            entrypoint,
            sourceCode,
            dependencies: dependencies!,
          })
          if (registered.slug !== requestedSlug) {
            ui.warn(`Slug "${requestedSlug}" was taken. Using "${registered.slug}".`)
          }
          config = {
            projectId: registered.projectId,
            functionId: registered.functionId,
            slug: registered.slug,
            name,
            ...(registered.publicUrl ? { publicUrl: registered.publicUrl } : {}),
          }
          await writeProjectConfig(config, cwd)
          ui.step(`Wrote .zavu/config.json — later deploys reuse it.`)
        }

        // Architecture precedence: CLI flag > package.json > server default (arm64).
        // Validate so we surface bad input before the deploy round-trip.
        const archInput = opts.arch ?? pkgArch
        let architecture: "arm64" | "x86_64" | undefined
        if (archInput !== undefined) {
          if (archInput !== "arm64" && archInput !== "x86_64") {
            fail(`Invalid --arch "${archInput}". Use "arm64" (default) or "x86_64".`)
          }
          architecture = archInput as "arm64" | "x86_64"
        }

        await deployAndWait({
          client,
          functionId: config!.functionId,
          label: `${config!.name} (${config!.slug})`,
          files,
          entrypoint,
          sourceCode,
          dependencies: dependencies!,
          architecture,
          updateRuntime: opts.updateRuntime,
        })
      }
    )
}
