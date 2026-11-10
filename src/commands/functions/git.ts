// `npx zavudev functions git …` — link a GitHub repository to this function so
// every push deploys it.
//
// Linking used to be a dashboard-only action, which meant deploy-on-push could
// not be set up from a script, from CI, or by a coding agent — the one audience
// the platform is sold to. These commands are that flow over the public API.
//
// There are two ways a link authenticates, and which one you get depends on the
// project, not on the flags:
//
//   app     — the Zavu GitHub App is installed on the account. Pushes arrive on
//             the app's own webhook and private repositories work. Nothing to
//             configure in the repository.
//   manual  — no installation. We mint a secret for this link and you wire the
//             repository's webhook yourself. The secret is printed once.
//
// Most commands read the function from .zavu/config.json, so you rarely pass
// --function.

import { Command } from "commander"
import { buildClient } from "../../lib/client"
import { readProjectConfig } from "../../lib/config"
import { ui, fail, cli, extractServerError } from "../../lib/ui"

// The API sends these as explicit nulls rather than omitting them, so a missing
// value and an absent field never have to be told apart.
interface GitLink {
  id: string
  functionId: string
  provider: "github"
  owner: string
  repo: string
  branch: string
  rootDir: string | null
  autoDeploy: boolean
  /** Derived server-side from whether the project has a GitHub App installation. */
  connection: "app" | "manual"
  lastStatus: "deploying" | "deployed" | "failed" | null
  lastCommitSha: string | null
  lastCommitMessage: string | null
  lastError: string | null
  lastDeployAt: string | null
  createdAt: string
  updatedAt: string
}

interface CreateResponse {
  link: GitLink
  webhookUrl: string
  /** Manual links only, and only here. Every later read strips it. */
  webhookSecret?: string
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  // "No link yet" is a normal state of a function, not a failure, but the API
  // reports it the way REST should: the subresource is absent, so 404. Without
  // this the most common `git status` — a function nobody has linked — would
  // exit non-zero with a server error instead of saying so.
  opts: { nullOn404?: boolean } = {}
): Promise<T> {
  const client = await buildClient()
  const res = await fetch(`${client.baseURL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${client.apiKey}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return undefined as T
  if (res.status === 404 && opts.nullOn404) return null as T
  if (!res.ok) {
    fail(await extractServerError(res, `${method} ${path} → ${res.status}`))
  }
  return (await res.json()) as T
}

async function resolveFunctionId(explicit?: string): Promise<string> {
  if (explicit) return explicit
  const config = await readProjectConfig()
  if (!config) {
    fail(
      "No --function <id> and no .zavu/config.json. Run from a function directory, or pass --function."
    )
  }
  return config!.functionId
}

/**
 * Accepts what a developer has in the clipboard: `owner/repo`, a github.com
 * URL, or an SSH remote. Anything else is rejected here rather than turning
 * into a 400 after a round-trip.
 */
export function parseRepoArg(input: string): { owner: string; repo: string } {
  const trimmed = input.trim().replace(/\.git$/, "")
  const url = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)/)
  const pair = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/)
  const m = url ?? pair
  if (!m) {
    fail(`Could not read "${input}" as a repository. Use owner/repo or a github.com URL.`)
  }
  return { owner: m![1], repo: m![2] }
}

function printLink(link: GitLink): void {
  ui.info(`${link.owner}/${link.repo} · ${link.branch}${link.rootDir ? ` · /${link.rootDir}` : ""}`)
  ui.hint(`Deploy on push: ${link.autoDeploy ? "on" : "off"}`)
  ui.hint(`Connection:     ${link.connection === "app" ? "GitHub App" : "manual webhook"}`)
  if (link.lastStatus) {
    const commit = link.lastCommitSha ? ` · ${link.lastCommitSha.slice(0, 7)}` : ""
    ui.hint(`Last deploy:    ${link.lastStatus}${commit}`)
    if (link.lastStatus === "failed" && link.lastError) ui.hint(`                ${link.lastError}`)
  } else {
    ui.hint("Last deploy:    none yet")
  }
}

export function functionsGitCommand(): Command {
  const cmd = new Command("git").description(
    "Link a GitHub repository to this function and deploy on every push."
  )

  cmd
    .command("link <repo>")
    .description("Link a repository. Accepts owner/repo or a github.com URL.")
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .option("--branch <name>", "Branch that deploys", "main")
    .option("--root <dir>", "Subdirectory holding the project (monorepos)")
    .option("--no-auto-deploy", "Link the repository but ignore pushes for now")
    .option("--json", "Print as JSON")
    .action(
      async (
        repoArg: string,
        opts: {
          function?: string
          branch: string
          root?: string
          autoDeploy: boolean
          json?: boolean
        }
      ) => {
        const functionId = await resolveFunctionId(opts.function)
        const { owner, repo } = parseRepoArg(repoArg)
        const res = await api<CreateResponse>("POST", `/v1/functions/${functionId}/git-link`, {
          owner,
          repo,
          branch: opts.branch,
          rootDir: opts.root,
          autoDeploy: opts.autoDeploy,
        })

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }

        ui.success(`Linked ${owner}/${repo} (${opts.branch}).`)
        printLink(res.link)

        if (res.link.connection === "app") {
          ui.hint("Pushes arrive through the Zavu GitHub App. Nothing to set up in the repository.")
          return
        }

        // Manual link: the secret exists exactly here. Everything downstream
        // strips it, and re-linking mints a new one, so a developer who walks
        // away from this output has to re-link.
        ui.info("")
        ui.info("Add a webhook to the repository with these values:")
        ui.hint(`  Payload URL:  ${res.webhookUrl}`)
        ui.hint(`  Secret:       ${res.webhookSecret ?? "(not returned)"}`)
        ui.hint("  Content type: application/json")
        ui.hint("  Events:       just the push event")
        ui.info("")
        ui.hint("The secret is shown only now. Re-linking generates a new one.")
      }
    )

  cmd
    .command("status")
    .description("Show the linked repository and the last deploy.")
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .option("--json", "Print as JSON")
    .action(async (opts: { function?: string; json?: boolean }) => {
      const functionId = await resolveFunctionId(opts.function)
      const res = await api<{ link: GitLink } | null>(
        "GET",
        `/v1/functions/${functionId}/git-link`,
        undefined,
        { nullOn404: true }
      )
      if (opts.json) {
        process.stdout.write(JSON.stringify(res?.link ?? null, null, 2) + "\n")
        return
      }
      if (!res?.link) {
        ui.info(`No repository linked. Link one with ${cli("fn git link <owner/repo>")}.`)
        return
      }
      printLink(res.link)
    })

  cmd
    .command("set")
    .description("Change the linked branch, root directory, or whether pushes deploy.")
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .option("--branch <name>", "Branch that deploys")
    .option("--root <dir>", "Subdirectory holding the project. Pass an empty string to clear it.")
    .option("--auto-deploy", "Deploy on push")
    .option("--no-auto-deploy", "Keep the link but ignore pushes")
    .action(
      async (opts: {
        function?: string
        branch?: string
        root?: string
        autoDeploy?: boolean
      }) => {
        const functionId = await resolveFunctionId(opts.function)
        const patch: Record<string, unknown> = {}
        if (opts.branch !== undefined) patch.branch = opts.branch
        // An empty --root is how you say "no subdirectory"; the API takes null
        // for that, and omitting the field means "leave it alone".
        if (opts.root !== undefined) patch.rootDir = opts.root === "" ? null : opts.root
        // commander only leaves autoDeploy undefined when neither flag is given.
        if (opts.autoDeploy !== undefined) patch.autoDeploy = opts.autoDeploy
        if (Object.keys(patch).length === 0) {
          fail("Nothing to change. Pass --branch, --root, or --auto-deploy / --no-auto-deploy.")
        }
        const res = await api<{ link: GitLink }>(
          "PATCH",
          `/v1/functions/${functionId}/git-link`,
          patch
        )
        ui.success("Link updated.")
        printLink(res.link)
      }
    )

  cmd
    .command("deploy")
    .description("Fetch the linked branch and deploy it now, without waiting for a push.")
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .action(async (opts: { function?: string }) => {
      const functionId = await resolveFunctionId(opts.function)
      await api("POST", `/v1/functions/${functionId}/git-link/deploy`)
      ui.success("Deploy started from the linked branch.")
      ui.hint(`Watch it with ${cli("fn git status")} or in the dashboard.`)
    })

  cmd
    .command("unlink")
    .description("Remove the link. The function and its deployments stay.")
    .option("--function <id>", "Function ID (defaults to .zavu/config.json)")
    .action(async (opts: { function?: string }) => {
      const functionId = await resolveFunctionId(opts.function)
      await api("DELETE", `/v1/functions/${functionId}/git-link`)
      ui.success("Repository unlinked.")
      ui.hint("A manual webhook in the repository stops working; remove it there too.")
    })

  return cmd
}
