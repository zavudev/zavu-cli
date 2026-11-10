// `npx zavudev import <repo>` — bring an agent project in from GitHub and put
// it live on Zavu in one command.
//
//   npx zavudev import acme/support-bot                 # eve or Zavu native, auto-detected
//   npx zavudev import acme/monorepo --root agents/bot  # project in a subdirectory
//   npx zavudev import acme/support-bot#staging         # branch / tag / commit
//
// Flow: download the repo tarball → detect the framework (eve layout or Zavu
// native) → register the function → install deps (eve needs esbuild to
// compile) → deploy. Private repos work with a GITHUB_TOKEN env var; the token
// is only ever sent to the code host, never to Zavu.

import { Command } from "commander"
import { mkdtemp, writeFile, readFile, cp, rm, mkdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, basename, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { buildClient } from "../../lib/client"
import { writeProjectConfig } from "../../lib/config"
import { ui, fail, cli } from "../../lib/ui"
import { registerFunction, slugify, dirHasContents } from "../../lib/registerFunction"
import { resolveProjectId } from "../../lib/scaffold"
import { deployAndWait } from "../../lib/deployRun"
import {
  detectFramework,
  compileEveProject,
  printEveReport,
  type Framework,
} from "../../lib/frameworks"

export interface RepoRef {
  owner: string
  repo: string
  /** Branch, tag, or commit. Undefined = the repo's default branch. */
  ref?: string
}

/**
 * Accepts `owner/repo`, `owner/repo#ref`, and github.com URLs (with optional
 * `.git` suffix or `/tree/<ref>` path). Throws on anything else — an import
 * that guesses wrong clones the wrong code.
 */
export function parseRepoRef(input: string): RepoRef {
  let s = input.trim()
  s = s.replace(/^git@github\.com:/, "")
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//, "")
  s = s.replace(/\.git$/, "")
  let ref: string | undefined
  const hashIdx = s.indexOf("#")
  if (hashIdx !== -1) {
    ref = s.slice(hashIdx + 1) || undefined
    s = s.slice(0, hashIdx)
  }
  const parts = s.split("/").filter(Boolean)
  if (parts.length >= 4 && parts[2] === "tree") {
    // github.com/owner/repo/tree/<ref>[/subpath] — take only the ref segment;
    // deeper paths are the --root flag's job, not the ref's.
    ref = ref ?? parts[3]
    parts.length = 2
  }
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Could not parse "${input}" as a GitHub repo. Use owner/repo, owner/repo#ref, or a github.com URL.`
    )
  }
  return { owner: parts[0], repo: parts[1], ref }
}

async function downloadTarball(refSpec: RepoRef): Promise<Buffer> {
  const ref = refSpec.ref ?? "HEAD"
  const url = `https://codeload.github.com/${refSpec.owner}/${refSpec.repo}/tar.gz/${encodeURIComponent(ref)}`
  const headers: Record<string, string> = {}
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }
  const res = await fetch(url, { headers })
  if (!res.ok) {
    if (res.status === 404) {
      fail(
        `GitHub returned 404 for ${refSpec.owner}/${refSpec.repo}${refSpec.ref ? `#${refSpec.ref}` : ""}. ` +
          "Check the name and ref. For a private repo, set the GITHUB_TOKEN environment variable (it is sent only to GitHub)."
      )
    }
    fail(`Download failed (${res.status}) for ${refSpec.owner}/${refSpec.repo}.`)
  }
  return Buffer.from(await res.arrayBuffer())
}

function extractTarball(tarPath: string, destDir: string): void {
  const result = spawnSync("tar", ["-xzf", tarPath, "-C", destDir], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false,
  })
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.toString().trim()
    fail(
      "Could not extract the repo archive with `tar`." +
        (detail ? ` ${detail}` : "") +
        " tar ships with macOS, Linux, and Windows 10+; make sure it is on your PATH."
    )
  }
}

function runNpm(args: string[], cwd: string): boolean {
  const result = spawnSync("npm", args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  return !result.error && result.status === 0
}

export function functionsImportCommand(): Command {
  return new Command("import")
    .description(
      "Import an agent project from GitHub — eve layout or Zavu native — and deploy it to Zavu."
    )
    .argument("<repo>", "GitHub repo: owner/repo, owner/repo#ref, or a github.com URL")
    .option("--dir <path>", "Directory to import into (defaults to ./<repo>)")
    .option("--root <subdir>", "Subdirectory of the repo that holds the project (monorepos)")
    .option("--name <name>", "Function name (defaults to the repo name)")
    .option("--slug <slug>", "URL slug (lowercase, hyphenated)")
    .option(
      "--sender <senderId>",
      "Sender the agent answers on (eve projects). Falls back to the SENDER_ID secret."
    )
    .option("--http", "Expose the function on a public HTTPS URL")
    .option("--no-install", "Skip `npm install` (eve projects need it to compile)")
    .option("--no-deploy", "Register and scaffold only; deploy later with `npx zavudev deploy`")
    .action(
      async (
        repoInput: string,
        opts: {
          dir?: string
          root?: string
          name?: string
          slug?: string
          sender?: string
          http?: boolean
          install: boolean
          deploy: boolean
        }
      ) => {
        let refSpec: RepoRef
        try {
          refSpec = parseRepoRef(repoInput)
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
        }
        const client = await buildClient()

        // The default target is named after the repo, so a file that already
        // carries that name collides with it. Saying "directory is not empty"
        // there is both wrong and dangerous: it invites clearing whatever sits
        // at that path, which in a workspace whose CLI is a file called `zavu`
        // means deleting the CLI to import `owner/zavu`.
        const targetDir = resolve(opts.dir ?? refSpec!.repo)
        const existing = await stat(targetDir).catch(() => null)
        if (existing && !existing.isDirectory()) {
          fail(
            `${targetDir} already exists and is a file, so the import has nowhere to go. Pass --dir <other>.`
          )
        }
        if (await dirHasContents(targetDir)) {
          fail(`Directory ${targetDir} is not empty. Pass --dir <other> or clear it first.`)
        }

        ui.step(
          `Downloading ${refSpec!.owner}/${refSpec!.repo}${refSpec!.ref ? `#${refSpec!.ref}` : ""}…`
        )
        const tarball = await downloadTarball(refSpec!)

        const workDir = await mkdtemp(join(tmpdir(), "zavu-import-"))
        try {
          const tarPath = join(workDir, "repo.tar.gz")
          await writeFile(tarPath, tarball)
          const extractDir = join(workDir, "x")
          await mkdir(extractDir, { recursive: true })
          extractTarball(tarPath, extractDir)

          // codeload archives contain a single "<repo>-<ref>/" root folder.
          const { readdir } = await import("node:fs/promises")
          const entries = await readdir(extractDir)
          if (entries.length !== 1) {
            fail("Unexpected archive layout from GitHub — expected a single root folder.")
          }
          const repoRoot = join(extractDir, entries[0])
          const srcDir = opts.root ? join(repoRoot, opts.root) : repoRoot
          if (await dirHasContents(srcDir) === false) {
            fail(
              opts.root
                ? `--root ${opts.root} does not exist (or is empty) in the repo.`
                : "The downloaded repo is empty."
            )
          }

          await cp(srcDir, targetDir, { recursive: true })
        } finally {
          await rm(workDir, { recursive: true, force: true }).catch(() => {})
        }

        const detection = await detectFramework(targetDir)
        if (detection.framework === "unknown") {
          fail(
            `Could not recognize the project: ${detection.evidence}. ` +
              `The files were kept in ${targetDir} for inspection. ` +
              "Supported layouts: Zavu native (index.ts) and eve (agent/instructions.md). " +
              "For a monorepo, point --root at the project directory."
          )
        }
        ui.info(`Detected framework: ${frameworkLabel(detection.framework)} (${detection.evidence})`)

        // Read (or create) package.json — the deploy needs its dependencies,
        // and eve projects need esbuild in devDependencies to compile.
        const pkgPath = join(targetDir, "package.json")
        let pkg: {
          name?: string
          private?: boolean
          type?: string
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        } = {}
        let pkgExisted = true
        try {
          pkg = JSON.parse(await readFile(pkgPath, "utf8"))
        } catch {
          pkgExisted = false
        }

        const name = opts.name ?? refSpec!.repo
        const requestedSlug = opts.slug ?? (slugify(name) || slugify(refSpec!.repo) || "imported")

        // Registration seeds the server-side draft. For eve projects the real
        // source only exists after compilation, so the draft is a placeholder
        // the deploy below immediately replaces.
        let initialSource: string
        if (detection.framework === "zavu-native") {
          initialSource = await readFile(join(targetDir, "index.ts"), "utf8")
        } else {
          initialSource = "// Imported eve project — the deployed source is compiled by `zavudev deploy`.\n"
        }

        ui.step(`Creating function "${name}" in your Zavu project…`)
        const fnId = await registerFunction(client, {
          name,
          slug: requestedSlug,
          sourceCode: initialSource,
          dependencies: pkg.dependencies ?? {},
          httpEnabled: opts.http,
        })
        if (fnId.slug !== requestedSlug) {
          ui.warn(`Slug "${requestedSlug}" was taken — used "${fnId.slug}" instead.`)
        }

        await writeProjectConfig(
          {
            projectId: fnId.projectId || (await resolveProjectId(client)),
            functionId: fnId.functionId,
            slug: fnId.slug,
            name,
          },
          targetDir
        )

        if (detection.framework === "eve") {
          // esbuild does the client-side flatten; make sure the project can
          // resolve it after install.
          if (!pkg.devDependencies?.esbuild && !pkg.dependencies?.esbuild) {
            pkg.devDependencies = { ...(pkg.devDependencies ?? {}), esbuild: "^0.24.0" }
            if (!pkgExisted) {
              pkg.name = pkg.name ?? fnId.slug
              pkg.private = pkg.private ?? true
              pkg.type = pkg.type ?? "module"
            }
            await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8")
          }
          if (opts.install) {
            ui.step("Installing dependencies (needed to compile the eve layout)…")
            if (!runNpm(["install"], targetDir)) {
              fail(
                `npm install failed in ${targetDir}. Fix the install, then run \`${cli("deploy")}\` from that directory.`
              )
            }
          }
        }

        if (!opts.deploy) {
          await ui.scrambleSuccess(`Imported into ${targetDir}.`)
          printNextSteps(targetDir, detection.framework, opts.sender)
          return
        }

        let sourceCode: string
        let dependencies: Record<string, string>
        if (detection.framework === "eve") {
          let compiled
          try {
            compiled = await compileEveProject(targetDir, { senderId: opts.sender })
          } catch (err) {
            fail(
              (err instanceof Error ? err.message : String(err)) +
                ` The project was imported into ${targetDir}; fix the issue and run \`${cli("deploy")}\` there.`
            )
          }
          printEveReport(compiled!.analysis, { sender: opts.sender })
          sourceCode = compiled!.sourceCode
          dependencies = compiled!.dependencies
        } else {
          sourceCode = initialSource
          dependencies = pkg.dependencies ?? {}
        }

        await deployAndWait({
          client,
          functionId: fnId.functionId,
          label: `${name} (${fnId.slug})`,
          sourceCode,
          dependencies,
        })
        printNextSteps(targetDir, detection.framework, opts.sender)
      }
    )
}

function frameworkLabel(fw: Framework): string {
  return fw === "eve" ? "eve" : "Zavu native"
}

function printNextSteps(targetDir: string, fw: Framework, sender?: string): void {
  ui.info("\nNext steps:")
  ui.hint(`cd ${basename(targetDir)}`)
  if (fw === "eve" && !sender) {
    ui.hint(cli("fn secrets set SENDER_ID <senderId>   # which sender the agent answers on"))
  }
  ui.hint(cli("agents test <agentId> --message 'hi'    # dry-run the agent"))
  ui.hint(cli("deploy                                  # redeploy after edits"))
}
