// `npx zavudev functions deploy` — figure out what kind of project the current
// directory holds, produce a single sourceCode, and push it to Zavu's deploy
// pipeline.
//
// Two project formats deploy today:
//   - Zavu native: a root index.ts. Sent as-is; the server-side Build Worker
//     (esbuild + npm install) does all bundling, exactly as before.
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

/**
 * Relative imports in a single-file deploy, which cannot resolve.
 *
 * Deliberately syntactic rather than a real parse: it runs on source we are
 * about to upload anyway. But a false positive here is not cheap, because there
 * is no override flag: it blocks a deploy that would have worked, over source
 * the user cannot see the problem in. So the scan tracks whether it is inside a
 * string before it believes an import, and it skips `import type`, which the
 * bundler erases without ever resolving.
 *
 * The specifier itself is a string, so strings cannot simply be deleted. They
 * are replaced by a marker that remembers which string it was; a marker that
 * survives in import position is resolved back to its text.
 */
function maskStrings(source: string): { masked: string; strings: string[] } {
  const strings: string[] = []
  let masked = ""
  let i = 0

  // Whether a `/` at this point starts a regex or divides. A regex can only
  // begin where a value cannot follow, so the last meaningful character decides
  // it. Without this the quote inside `/["']/` opens a string that runs to the
  // next quote, and everything after shifts by one: a path named in a prompt
  // lands in import position and blocks a deploy that works. `/["']/` and
  // `/['"]/` gave opposite answers, decided by the order of two characters.
  let regexAllowed = true
  // Template literals nest through `${...}`, and the inner backtick used to be
  // read as the outer one closing.
  const templates: number[] = []

  const lastMeaningful = () => {
    for (let j = masked.length - 1; j >= 0; j--) {
      if (!/\s/.test(masked[j])) return masked[j]
    }
    return ""
  }

  while (i < source.length) {
    const c = source[i]

    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++
      i += 2
      continue
    }

    // A regex literal. Consumed whole so its contents cannot be mistaken for
    // anything: not a string, not a comment, not an import.
    if (c === "/" && regexAllowed) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < source.length) {
        const d = source[j]
        if (d === "\\") { j += 2; continue }
        if (d === "\n") break
        if (d === "[") inClass = true
        else if (d === "]") inClass = false
        else if (d === "/" && !inClass) { closed = true; break }
        j++
      }
      if (closed) {
        masked += " "
        i = j + 1
        regexAllowed = false
        continue
      }
      // Unterminated: treat it as division and carry on.
    }

    // A template literal is consumed whole, interpolations and all, and
    // replaced by a space. Reading `${...}` as code and resuming the text after
    // it is what a parser does, and getting the resume point wrong turns the
    // rest of the template into code: `\`pre ${x} import y from "./z"\`` then
    // reports ./z. An import written inside an interpolation is missed, which
    // costs a clear esbuild error a minute later; the other way costs a blocked
    // deploy. Nesting is tracked so an inner template does not end the outer.
    if (c === "`") {
      i++
      let depth = 0
      while (i < source.length) {
        const d = source[i]
        if (d === "\\") { i += 2; continue }
        if (d === "`" && depth === 0) { i++; break }
        if (d === "$" && source[i + 1] === "{") { depth++; i += 2; continue }
        if (d === "}" && depth > 0) { depth--; i++; continue }
        i++
      }
      masked += " "
      regexAllowed = false
      continue
    }

    if (c === '"' || c === "'") {
      const quote = c
      i++
      let text = ""
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          text += source[i] + (source[i + 1] ?? "")
          i += 2
          continue
        }
        text += source[i]
        i++
      }
      i++ // closing quote
      strings.push(text)
      masked += `${quote}\u0000${strings.length - 1}\u0000${quote}`
      regexAllowed = false
      continue
    }

    masked += c
    i++
    if (!/\s/.test(c)) {
      // A value can follow these, so a `/` after them divides. Anywhere else
      // (an operator, a comma, an opening bracket) a regex may start.
      regexAllowed = !/[\w$)\]]/.test(lastMeaningful())
    }
  }

  return { masked, strings }
}

const MARKER = /["'`]\u0000(\d+)\u0000["'`]/.source

/**
 * Import forms the bundler erases without ever resolving the file, so a
 * single-file deploy is fine and flagging them stops a deploy that works:
 *
 *   import type { A } from "./t"          including across lines
 *   import { type A, type B } from "./t"  every specifier type-only
 *   export type { A } from "./t"
 *
 * `import { type A, b }` keeps a runtime binding, so it is NOT erased and must
 * still be reported.
 */
function stripErasedImports(masked: string): string {
  const typeKeyword = new RegExp(
    String.raw`\b(?:import|export)\s+type\b[\s\S]*?from\s+${MARKER}`,
    "g"
  )
  let out = masked.replace(typeKeyword, " ")

  const braced = new RegExp(
    String.raw`\b(?:import|export)\s*\{([^}]*)\}\s*from\s+${MARKER}`,
    "g"
  )
  out = out.replace(braced, (whole, specifiers: string) => {
    const parts = specifiers
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
    const allTypes = parts.length > 0 && parts.every((p) => /^type\s/.test(p))
    return allTypes ? " " : whole
  })

  return out
}

export function findRelativeImports(source: string): string[] {
  const { masked, strings } = maskStrings(source)
  const scannable = stripErasedImports(masked)

  const patterns = [
    new RegExp(String.raw`\bfrom\s+${MARKER}`, "g"),
    new RegExp(String.raw`\brequire\s*\(\s*${MARKER}\s*\)`, "g"),
    new RegExp(String.raw`\bimport\s*\(\s*${MARKER}\s*\)`, "g"),
    new RegExp(String.raw`\bimport\s+${MARKER}`, "g"),
  ]

  const found = new Set<string>()
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(scannable))) {
      const spec = strings[Number(m[1])]
      if (spec?.startsWith(".")) found.add(spec)
    }
  }
  return [...found]
}

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

        let sourceCode: string
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
          try {
            sourceCode = await readFile(join(cwd, opts.source), "utf8")
          } catch {
            if (detection.framework === "unknown") {
              fail(
                `Could not read ${opts.source}, and this directory is neither a Zavu function (index.ts) nor an eve project (agent/instructions.md). Pass --source <file> if your entrypoint is named differently.`
              )
            }
            fail(`Could not read ${opts.source}. Pass --source <file> if your entrypoint is named differently.`)
          }
          dependencies = pkgDependencies

          // The native path uploads this one file and nothing else: the build
          // worker writes it beside its wrapper and runs esbuild on that pair.
          // A relative import therefore resolves to a file that is not on the
          // build box, and the deploy dies with esbuild's `Could not resolve`,
          // which says nothing about the actual rule. Catch it here, before
          // the upload, and say what to do instead.
          //
          // This warns and continues rather than stopping the deploy. Deciding
          // "is this an import" from source text without parsing it is a
          // heuristic, and the two ways it can be wrong cost wildly different
          // amounts: a missed import reaches esbuild, which fails clearly a
          // moment later, while a false alarm would stop a deploy that works
          // with no way to override it. Adversarial testing found five inputs
          // that tripped it, including a prompt whose text was misread because
          // a regex literal earlier in the file contained a quote. Those are
          // fixed, and the next one should cost a stray warning, not someone's
          // afternoon.
          const relativeImports = findRelativeImports(sourceCode)
          if (relativeImports.length > 0) {
            const list = relativeImports.map((i) => `  ${i}`).join("\n")
            ui.warn(
              `${opts.source} looks like it imports files next to it, and a Zavu function deploys as a single file:\n\n${list}\n\n` +
                `If that is right, the build will fail to resolve them. Inline them, or deploy the whole repository instead:\n` +
                `  npx zavudev fn git link <owner>/<repo> --branch main\n\n` +
                `npm dependencies are fine: declare them in package.json and they are installed and bundled.`
            )
          }
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
            sourceCode: sourceCode!,
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
          sourceCode: sourceCode!,
          dependencies: dependencies!,
          architecture,
          updateRuntime: opts.updateRuntime,
        })
      }
    )
}
