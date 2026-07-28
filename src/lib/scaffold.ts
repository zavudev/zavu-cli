// Files every scaffolded Zavu Function needs to be a real TypeScript project on
// the developer's machine.
//
// The runtime is provided by the Lambda layer in production, so none of this is
// required to deploy. It is required for the project to be *workable*: without
// it, `import { defineAgent } from "@zavudev/functions"` is a red line in the
// editor, `tsc` cannot resolve it, and `zavu fn invoke` cannot load the module
// at all. For a product whose pitch is "your TypeScript", that is the entire
// first impression.
//
// This used to write a hand-maintained stand-in and point `tsconfig.paths` at
// it. Now that @zavudev/functions is published, a plain dependency does the
// same job with no bespoke mechanism and no second copy of the contract left to
// drift — which is the failure mode that has cost us the most.

import { writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Runtime dependency written into a scaffolded project.
 *
 * A devDependency on purpose: the layer supplies it at runtime and the bundler
 * marks it external, so it is never shipped. The Build Worker installs user
 * deps with `--omit=dev`, so declaring it here keeps it out of the server-side
 * install and out of the dependency cache key, while the developer still gets
 * types and local execution from `npm install`.
 */
export const RUNTIME_DEV_DEPENDENCY: Record<string, string> = {
  "@zavudev/functions": "^0.1.0",
  // The blank template imports the SDK on its first line, but it was never
  // added here, so a fresh scaffold failed with "Cannot find module
  // '@zavudev/sdk'" before the developer had changed anything. The range is
  // pinned to the real published major: guessing "^0.1.0" from the line above
  // resolves to nothing, since the SDK is versioned independently.
  "@zavudev/sdk": "^0.51.0",
  // Handlers read process.env and call fetch. The tsconfig asks for node types,
  // so without this a fresh scaffold fails to typecheck before the developer
  // has written a line.
  "@types/node": "^24.0.0",
  // We tell people to run `tsc --noEmit`, and without this `npx tsc` resolves
  // `tsc@2.0.4` from the registry — an unrelated deprecated package that prints
  // "This is not the tsc command you are looking for" and exits 0. A typecheck
  // that passes without checking anything is worse than no typecheck, so the
  // compiler ships with the scaffold.
  typescript: "^5.6.0",
}

const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: ["ES2022"],
    // Handlers read secrets from process.env and call fetch; without node types
    // a scaffold that does the obvious thing fails to typecheck.
    types: ["node"],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ["*.ts"],
}

/** Write the tsconfig a scaffolded project needs. Idempotent. */
export async function writeTsconfig(targetDir: string): Promise<void> {
  await writeFile(
    join(targetDir, "tsconfig.json"),
    JSON.stringify(TSCONFIG, null, 2) + "\n",
    "utf8"
  )
}

/**
 * `.zavu/` holds `config.json` — the projectId, functionId and slug. It used to
 * be gitignored, which meant a teammate who cloned the repo had no way to
 * discover the function id, and there is no command to look one up. None of it
 * is secret (secrets live server-side and are never written here), so it
 * belongs in version control.
 */
/**
 * `.env` is here because the docs tell you to put real secrets in it, and the
 * same docs tell you to commit `.zavu/` — so the expected flow has this
 * directory under version control. Without this line, following both
 * instructions literally commits DATABASE_URLs and API keys. Every other entry
 * costs a rebuild; this one costs credentials.
 */
export const SCAFFOLD_GITIGNORE = [
  "node_modules/",
  "*.log",
  ".env",
  ".env.*",
  "!.env.example",
  "",
].join("\n")

/**
 * Resolve the project id a scaffolded function belongs to.
 *
 * `POST /v1/functions` returns the function, not the project, so both scaffold
 * paths used to write `projectId: ""` into `.zavu/config.json` with a comment
 * saying it was "implicit from the API key". It is implicit to the server, but
 * not to anything reading the file: `zavu fn invoke` falls back to the string
 * "project_local", so the local run reports a project that does not exist.
 *
 * `/v1/me` exists precisely to answer "which project is this key bound to".
 *
 * Best-effort on purpose: an older server without `/v1/me` should still produce
 * a working scaffold, so a failure here degrades to the old empty string rather
 * than aborting a `pull` that has already created the function server-side.
 */
export async function resolveProjectId(api: {
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<T>
}): Promise<string> {
  try {
    const me = await api.get<{ project?: { id?: string } }>("/v1/me")
    return me.project?.id ?? ""
  } catch {
    return ""
  }
}
