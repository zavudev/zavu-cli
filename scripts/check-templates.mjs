// Typecheck every scaffolded template the way `zavudev init` produces it.
//
// Why this exists: nothing else compiles the templates. They are string
// literals in src/templates.ts, so `tsc` over this package never opens them,
// and the unit suite never runs them. A template that stopped compiling
// therefore shipped, and `zavudev init` handed out a project that failed
// `tsc --noEmit` before the developer had changed a line.
//
// What it does, per template: build a throwaway project exactly as init does
// (the code as index.ts, the same package.json, the tsconfig from
// writeTsconfig), point node_modules at the workspace copies of the packages,
// and run the compiler. Non-zero exit if any template fails.
//
// The dependencies are linked from the workspace rather than installed from
// npm on purpose: this has to pass for a version of @zavudev/functions that is
// not published yet, which is precisely when a template breaks.
//
// Run: bun run check:templates    (KEEP=1 to leave the sandboxes on disk)

import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

import { TEMPLATES } from "../src/templates.ts"
import { RUNTIME_DEV_DEPENDENCY, writeTsconfig } from "../src/lib/scaffold.ts"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "../../..")

/**
 * Packages the sandbox needs, and where the workspace keeps them.
 *
 * A missing one is a hard failure, never a skip: a check that quietly passes
 * because it could not resolve the compiler is worse than no check.
 */
const LINKS = [
  { name: "@zavudev/functions", from: join(repoRoot, "packages/zavu-functions") },
  { name: "@zavudev/sdk", from: join(repoRoot, "node_modules/@zavudev/sdk") },
  { name: "@types", from: join(repoRoot, "node_modules/@types") },
  { name: "typescript", from: join(repoRoot, "node_modules/typescript") },
]

const tscBin = join(repoRoot, "node_modules/typescript/bin/tsc")

function preflight() {
  const missing = LINKS.filter((l) => !existsSync(l.from)).map((l) => l.name)
  if (!existsSync(tscBin)) missing.push("typescript (bin)")
  if (missing.length) {
    console.error(`✗ Cannot check templates: ${missing.join(", ")} not found in the workspace.`)
    console.error(`  Run \`bun install\` at the repo root and try again.`)
    process.exit(1)
  }
}

/** Build one project the way `zavudev init` writes it, and compile it. */
async function checkTemplate(template, root) {
  const dir = join(root, template.id)
  await mkdir(join(dir, "node_modules/@zavudev"), { recursive: true })

  await writeFile(join(dir, "index.ts"), template.code, "utf8")
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: template.defaultSlug,
        private: true,
        type: "module",
        dependencies: template.dependencies,
        devDependencies: RUNTIME_DEV_DEPENDENCY,
      },
      null,
      2
    ) + "\n",
    "utf8"
  )
  await writeTsconfig(dir)

  for (const link of LINKS) {
    await symlink(link.from, join(dir, "node_modules", link.name), "dir")
  }

  const res = spawnSync(process.execPath, [tscBin, "--noEmit", "--project", dir], {
    encoding: "utf8",
  })
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim()
  return { ok: res.status === 0, output }
}

async function main() {
  preflight()
  const root = await mkdtemp(join(tmpdir(), "zavudev-templates-"))
  const failed = []

  try {
    for (const template of TEMPLATES) {
      const { ok, output } = await checkTemplate(template, root)
      if (ok) {
        console.log(`  ✓ ${template.id}`)
      } else {
        failed.push(template.id)
        console.log(`  ✗ ${template.id}`)
        // Rewrite the temp path to the file a reader can actually open.
        for (const line of output.split("\n")) {
          console.log(`      ${line.replace(/^.*index\.ts/, "index.ts")}`)
        }
      }
    }
  } finally {
    if (process.env.KEEP) console.log(`\n  sandboxes kept in ${root}`)
    else await rm(root, { recursive: true, force: true })
  }

  if (failed.length) {
    console.error(
      `\n✗ ${failed.length} template(s) do not compile: ${failed.join(", ")}.\n` +
        `  Every template is scaffolded by \`zavudev init\` with a strict tsconfig, so\n` +
        `  this is what a new project would report before anyone edits it.\n` +
        `  Fix the template in packages/zavu-cli/src/templates.ts, or the types it\n` +
        `  relies on, then re-run \`bun run check:templates\`.`
    )
    process.exit(1)
  }
  console.log(`\n✓ ${TEMPLATES.length} template(s) compile as scaffolded.`)
}

await main()
