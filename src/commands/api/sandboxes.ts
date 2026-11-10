// `zavudev sandboxes`: isolated Linux machines billed per second.
//
// Mirrors /v1/sandboxes, /v1/sandbox-snapshots and /v1/sandbox-environments.
// Starting one (create, resume, fork) costs money, so those say so in --help.

import { Command } from "commander"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { buildApi, ApiRequestError, type ApiClient } from "../../lib/api"
import { ui, fail, cli } from "../../lib/ui"
import { collectRepeatable } from "../../lib/phoneNumberRequirements"
import {
  buildCreateBody,
  formatCost,
  parseEnv,
  parseTimeout,
  SandboxFlagError,
} from "../../lib/sandboxes"

interface Sandbox {
  id: string
  name?: string | null
  status: string
  size: string
  stopReason?: string | null
  failureReason?: string | null
  costTotal?: number
  expiresAt?: string | null
}

const WAIT_TIMEOUT_MS = 3 * 60 * 1000

function errMsg(err: unknown): string {
  if (err instanceof SandboxFlagError) return err.message
  return err instanceof Error ? err.message : String(err)
}

function print(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n")
}

function row(s: Sandbox) {
  return {
    id: s.id,
    name: s.name ?? "—",
    status: s.status,
    size: s.size,
    cost: formatCost(s.costTotal),
  }
}

function summarize(s: Sandbox) {
  const parts = [s.status, s.size, formatCost(s.costTotal)]
  if (s.stopReason) parts.push(`stopped: ${s.stopReason}`)
  ui.info(`${s.id}${s.name ? ` (${s.name})` : ""} · ${parts.join(" · ")}`)
  if (s.failureReason) ui.hint(`failure: ${s.failureReason}`)
  if (s.status === "stopped" && s.expiresAt) ui.hint(`disk kept until ${s.expiresAt}`)
}

async function waitFor(api: ApiClient, id: string, targets: string[]): Promise<Sandbox> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  for (;;) {
    const { sandbox } = await api.get<{ sandbox: Sandbox }>(`/v1/sandboxes/${encodeURIComponent(id)}`)
    if (targets.includes(sandbox.status)) return sandbox
    if (sandbox.status === "failed") {
      fail(`The sandbox failed${sandbox.failureReason ? `: ${sandbox.failureReason}` : "."}`)
    }
    if (Date.now() > deadline) {
      fail(`Still ${sandbox.status} after 3 minutes. Check it with \`${cli(`sandboxes get ${id}`)}\`.`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

function sandboxPath(id: string, suffix = ""): string {
  return `/v1/sandboxes/${encodeURIComponent(id)}${suffix}`
}

export function sandboxesCommand(): Command {
  const cmd = new Command("sandboxes").description(
    "Isolated Linux machines to run code, commands and services, billed per second."
  )

  cmd
    .command("list")
    .description("List sandboxes, newest first.")
    .option("--status <status>", "starting | running | stopping | stopped | failed")
    .option("--limit <n>", "Page size", "20")
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: Sandbox[]; nextCursor?: string | null }>("/v1/sandboxes", {
          status: opts.status,
          limit: opts.limit,
          cursor: opts.cursor,
        })
        if (opts.json) return print(res)
        if (!res.items?.length) {
          ui.info(`No sandboxes. Start one: ${cli("sandboxes create")}`)
          return
        }
        ui.table(res.items.map(row))
        if (res.nextCursor) ui.hint(`More: --cursor ${res.nextCursor}`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("get <sandboxId>")
    .description("Show a sandbox.")
    .option("--json", "Print the raw JSON response")
    .action(async (id, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ sandbox: Sandbox }>(sandboxPath(id))
        if (opts.json) return print(res)
        summarize(res.sandbox)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("create")
    .description(
      "Start a sandbox. COSTS MONEY: $0.01 per start plus machine time per second. Paid plans only."
    )
    .option("--size <size>", "small | default | large")
    .option("--timeout <seconds>", "Stop it automatically after this many seconds (60 to 86400; default 3600)")
    .option("--no-timeout", "Never stop it automatically. It is billed until you stop it.")
    .option("--ephemeral", "Never save the disk: a stop erases it")
    .option("--name <name>", "Your label for it")
    .option("--env <KEY=value>", "Environment variable inside the machine. Repeat for each.", collectRepeatable)
    .option("--environment <name>", "Start with the variables of a saved environment")
    .option("--from <snapshot>", "A saved snapshot id, or a share code (zsh_...)")
    .option("--metadata <key=value>", "Your own label, returned on the sandbox. Repeat for each.", collectRepeatable)
    .option("--setup-script <file>", "A bash script to run once the machine is ready")
    .option("--idempotency-key <key>", "Retrying with the same key returns the first sandbox instead of a second one")
    .option("--wait", "Wait until it is running")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      let body: Record<string, unknown>
      try {
        const script = opts.setupScript ? await readFile(opts.setupScript, "utf8") : undefined
        body = buildCreateBody(opts, script)
      } catch (err) {
        fail(errMsg(err))
      }
      const api = await buildApi()
      try {
        let res: { sandbox: Sandbox }
        try {
          res = await api.post<{ sandbox: Sandbox }>("/v1/sandboxes", body!)
        } catch (err) {
          // A retried --idempotency-key answers 409 with the sandbox the first
          // request created. Nothing new was started or charged.
          const replay = err instanceof ApiRequestError && err.status === 409 && (err.body as any)?.sandbox
          if (!replay) throw err
          res = err.body as { sandbox: Sandbox }
          if (!opts.json) ui.info("That idempotency key was already used: this is the sandbox it created.")
        }
        const sandbox = opts.wait ? await waitFor(api, res.sandbox.id, ["running"]) : res.sandbox
        if (opts.json) return print({ sandbox })
        ui.success(`Sandbox ${sandbox.id} is ${sandbox.status}.`)
        ui.hint(`Run something: ${cli(`sandboxes exec ${sandbox.id} "uname -a"`)}`)
        ui.hint(`Stop it when you are done: ${cli(`sandboxes stop ${sandbox.id}`)}`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("stop <sandboxId>")
    .description("End the run and keep the disk for 14 days. Billing ends now.")
    .option("--wait", "Wait until it is stopped")
    .option("--json", "Print the raw JSON response")
    .action(async (id, opts) => {
      const api = await buildApi()
      try {
        const res = await api.post<{ sandbox: Sandbox }>(sandboxPath(id, "/stop"))
        const sandbox = opts.wait ? await waitFor(api, id, ["stopped"]) : res.sandbox
        if (opts.json) return print({ sandbox })
        summarize(sandbox)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("resume <sandboxId>")
    .description("Start a stopped sandbox again with its disk. COSTS MONEY, like create.")
    .option("--timeout <seconds>", "A new timeout for this run (60 to 86400)")
    .option("--no-timeout", "Never stop it automatically, this run and later ones")
    .option("--wait", "Wait until it is running")
    .option("--json", "Print the raw JSON response")
    .action(async (id, opts) => {
      let body: Record<string, unknown> = {}
      try {
        const timeout = parseTimeout(opts.timeout)
        if (timeout !== undefined) body = { timeoutSeconds: timeout }
      } catch (err) {
        fail(errMsg(err))
      }
      const api = await buildApi()
      try {
        const res = await api.post<{ sandbox: Sandbox }>(sandboxPath(id, "/resume"), body)
        const sandbox = opts.wait ? await waitFor(api, id, ["running"]) : res.sandbox
        if (opts.json) return print({ sandbox })
        summarize(sandbox)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("fork <sandboxId>")
    .description("Start a new sandbox with a copy of this one's disk. COSTS MONEY, like create.")
    .option("--wait", "Wait until the copy is running")
    .option("--json", "Print the raw JSON response")
    .action(async (id, opts) => {
      const api = await buildApi()
      try {
        const res = await api.post<{ sandbox: Sandbox }>(sandboxPath(id, "/fork"))
        const sandbox = opts.wait ? await waitFor(api, res.sandbox.id, ["running"]) : res.sandbox
        if (opts.json) return print({ sandbox })
        ui.success(`Copy ${sandbox.id} is ${sandbox.status}.`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("delete <sandboxId>")
    .description("Stop it if it is running and delete the machine and its disk. Cannot be undone.")
    .action(async (id) => {
      const api = await buildApi()
      try {
        await api.del(sandboxPath(id))
        ui.success(`Deleted ${id}`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("exec <sandboxId> <command...>")
    .description(
      "Run a shell command in the sandbox and print its output. Exits with the command's exit code."
    )
    .option("--cwd <dir>", "Working directory, relative to /home/user")
    .option("--timeout <seconds>", "Kill it after this many seconds (1 to 120; default 30)")
    .option("--background", "Start it and print a command id instead of waiting")
    .option("--json", "Print the raw JSON response")
    .addHelpText(
      "after",
      '\nPut the command after -- or in quotes, so its own flags are not read as these:\n' +
        '  zavudev sandboxes exec <sandboxId> -- ls -la\n' +
        '  zavudev sandboxes exec <sandboxId> "pip install requests && python3 main.py"\n'
    )
    .action(async (id, words: string[], opts) => {
      if (opts.timeout !== undefined) {
        const n = Number(opts.timeout)
        if (!Number.isInteger(n) || n < 1 || n > 120) {
          fail("--timeout is a whole number of seconds from 1 to 120. Use --background for longer.")
        }
      }
      const api = await buildApi()
      try {
        const res = await api.post<{ result?: any; command?: { id: string } }>(sandboxPath(id, "/commands"), {
          command: words.join(" "),
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.timeout ? { timeoutSeconds: Number(opts.timeout) } : {}),
          ...(opts.background ? { background: true } : {}),
        })
        if (opts.json) return print(res)
        if (res.command) {
          ui.success(`Started ${res.command.id}`)
          ui.hint(`Follow it: ${cli(`sandboxes command ${id} ${res.command.id}`)}`)
          return
        }
        const r = res.result
        if (r.stdout) process.stdout.write(r.stdout)
        if (r.stderr) process.stderr.write(r.stderr)
        if (r.stdoutTruncated || r.stderrTruncated) ui.hint("Output was truncated.")
        if (r.timedOut) {
          fail("Timed out. Use --background for anything longer than 120 seconds.", 124)
        }
        process.exit(typeof r.exitCode === "number" ? r.exitCode : 1)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("command <sandboxId> <commandId>")
    .description("Status and output of a command started with exec --background.")
    .option("--json", "Print the raw JSON response")
    .action(async (id, commandId, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ command: any }>(
          sandboxPath(id, `/commands/${encodeURIComponent(commandId)}`)
        )
        if (opts.json) return print(res)
        const c = res.command
        ui.info(`${c.id} · ${c.status}${typeof c.exitCode === "number" ? ` · exit ${c.exitCode}` : ""}`)
        if (c.stdout) process.stdout.write(c.stdout)
        if (c.stderr) process.stderr.write(c.stderr)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd.addCommand(filesCommand())
  cmd.addCommand(portsCommand())

  cmd
    .command("ssh <sandboxId>")
    .description("Authorize your public key on the machine and print the command to connect.")
    .option("--key <path>", "Public key file", join(homedir(), ".ssh", "id_ed25519.pub"))
    .option("--json", "Print the raw JSON response")
    .action(async (id, opts) => {
      let publicKey: string
      try {
        publicKey = (await readFile(opts.key, "utf8")).trim()
      } catch {
        fail(`Could not read ${opts.key}. Pass your public key file with --key.`)
      }
      const api = await buildApi()
      try {
        const res = await api.post<{ ssh: { command: string } }>(sandboxPath(id, "/ssh"), {
          publicKey: publicKey!,
        })
        if (opts.json) return print(res)
        ui.success("Key authorized. Connect with:")
        process.stdout.write(`${res.ssh.command}\n`)
        ui.hint("The address changes after a stop and resume: run this again then.")
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("desktop <sandboxId>")
    .description("A short-lived URL streaming the machine's screen, or Chrome alone.")
    .option("--view <view>", "desktop | browser", "desktop")
    .option("--json", "Print the raw JSON response")
    .action(async (id, opts) => {
      const api = await buildApi()
      try {
        const res = await api.post<{ desktop: { url: string } }>(sandboxPath(id, "/desktop"), {
          view: opts.view,
        })
        if (opts.json) return print(res)
        process.stdout.write(`${res.desktop.url}\n`)
        ui.hint("Open it within a few minutes. Anyone holding it can use the machine: treat it as a secret.")
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd.addCommand(snapshotsCommand())
  cmd.addCommand(environmentsCommand())
  return cmd
}

function filesCommand(): Command {
  const cmd = new Command("files").description("Read, write, list and delete files in a sandbox.")

  cmd
    .command("read <sandboxId> <path>")
    .description("Print a file, or save it with --out. Up to 5 MiB.")
    .option("--out <file>", "Save it to this local file instead of printing it")
    .action(async (id, path, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ file: { content: string } }>(sandboxPath(id, "/files"), {
          path,
          encoding: opts.out ? "base64" : "utf8",
        })
        if (opts.out) {
          await writeFile(opts.out, Buffer.from(res.file.content, "base64"))
          ui.success(`Saved ${opts.out}`)
          return
        }
        process.stdout.write(res.file.content)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("write <sandboxId> <path>")
    .description("Create or replace a file, from a local file or inline content. Up to 5 MiB.")
    .option("--file <local>", "Local file to upload")
    .option("--content <text>", "Inline text content")
    .action(async (id, path, opts) => {
      if (!opts.file === !opts.content) fail("Pass exactly one of --file <local> or --content <text>.")
      const body = opts.file
        ? { path, content: (await readFile(opts.file)).toString("base64"), encoding: "base64" }
        : { path, content: opts.content }
      const api = await buildApi()
      try {
        const res = await api.put<{ file: { path: string; size: number } }>(sandboxPath(id, "/files"), body)
        ui.success(`Wrote ${res.file.path} (${res.file.size} bytes)`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("list <sandboxId> [path]")
    .description("List one directory, /home/user by default.")
    .option("--json", "Print the raw JSON response")
    .action(async (id, path, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ files: any[]; truncated: boolean }>(sandboxPath(id, "/files/list"), {
          path,
        })
        if (opts.json) return print(res)
        if (!res.files?.length) {
          ui.info("Empty.")
          return
        }
        ui.table(
          res.files.map((f) => ({
            name: f.isDir ? `${f.name}/` : f.name,
            size: f.isDir ? "—" : String(f.size),
            modified: f.modifiedAt,
          }))
        )
        if (res.truncated) ui.hint("Showing the first 10,000 entries.")
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("rm <sandboxId> <path>")
    .description("Delete a file. A directory needs --recursive.")
    .option("--recursive", "Delete a directory and everything in it")
    .action(async (id, path, opts) => {
      const api = await buildApi()
      try {
        const query = new URLSearchParams({ path, ...(opts.recursive ? { recursive: "true" } : {}) })
        await api.del(sandboxPath(id, `/files?${query}`))
        ui.success(`Deleted ${path}`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  return cmd
}

function portsCommand(): Command {
  const cmd = new Command("ports").description("Give a port inside a sandbox an HTTPS URL.")

  cmd
    .command("expose <sandboxId> <port>")
    .description("Print a URL that reaches the port. The service must listen on 0.0.0.0.")
    .option("--public", "Anyone can open the URL. Without it, the URL carries an access token.")
    .option("--json", "Print the raw JSON response")
    .action(async (id, port, opts) => {
      const n = Number(port)
      if (!Number.isInteger(n) || n < 1 || n > 65535) fail("The port is a whole number from 1 to 65535.")
      const api = await buildApi()
      try {
        const res = await api.post<{ port: { url: string; public: boolean } }>(sandboxPath(id, "/ports"), {
          port: Number(port),
          ...(opts.public ? { public: true } : {}),
        })
        if (opts.json) return print(res)
        process.stdout.write(`${res.port.url}\n`)
        if (!res.port.public) ui.hint("Private: anyone holding the full URL can open it, so treat it as a secret.")
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("list <sandboxId>")
    .description("The ports this sandbox exposes.")
    .option("--json", "Print the raw JSON response")
    .action(async (id, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: any[] }>(sandboxPath(id, "/ports"))
        if (opts.json) return print(res)
        if (!res.items?.length) {
          ui.info("No ports exposed.")
          return
        }
        ui.table(
          res.items.map((p) => ({ port: String(p.port), access: p.public ? "public" : "private", url: p.url }))
        )
      } catch (err) {
        fail(errMsg(err))
      }
    })

  return cmd
}

function summarizeSnapshot(s: any) {
  ui.info(`${s.id} (${s.name}) · ${s.status} · ${s.size} · ${formatCost(s.costTotal)}`)
  if (typeof s.sizeBytes === "number") ui.hint(`${s.sizeBytes} bytes on disk`)
  if (s.shareCode) ui.hint("Shared. Print the code with `share`, revoke it with `unshare`.")
  if (s.failureReason) ui.hint(`failure: ${s.failureReason}`)
}

async function waitForSnapshot(api: ApiClient, id: string): Promise<any> {
  const deadline = Date.now() + 10 * 60 * 1000
  for (;;) {
    const { snapshot } = await api.get<{ snapshot: any }>(`/v1/sandbox-snapshots/${encodeURIComponent(id)}`)
    if (snapshot.status === "ready") return snapshot
    if (snapshot.status === "failed") {
      fail(`The save failed${snapshot.failureReason ? `: ${snapshot.failureReason}` : "."} Its first day was refunded.`)
    }
    if (Date.now() > deadline) {
      fail(`Still saving after 10 minutes. Check it with \`${cli(`sandboxes snapshots get ${id}`)}\`.`)
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
}

function snapshotsCommand(): Command {
  const cmd = new Command("snapshots").description(
    "Saved disks to start sandboxes from. $0.07 per started UTC day while kept."
  )

  cmd
    .command("list")
    .description("This project's saved snapshots.")
    .option("--limit <n>", "Page size", "20")
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: any[]; nextCursor?: string | null }>("/v1/sandbox-snapshots", {
          limit: opts.limit,
          cursor: opts.cursor,
        })
        if (opts.json) return print(res)
        if (!res.items?.length) {
          ui.info(`No snapshots. Save one: ${cli("sandboxes snapshots create <sandboxId> --name <name>")}`)
          return
        }
        ui.table(
          res.items.map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            size: s.size,
            shared: s.shareCode ? "yes" : "no",
            cost: formatCost(s.costTotal),
          }))
        )
        if (res.nextCursor) ui.hint(`More: --cursor ${res.nextCursor}`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("get <snapshotId>")
    .description("Show a saved snapshot.")
    .option("--json", "Print the raw JSON response")
    .action(async (snapshotId, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ snapshot: any }>(`/v1/sandbox-snapshots/${encodeURIComponent(snapshotId)}`)
        if (opts.json) return print(res)
        summarizeSnapshot(res.snapshot)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("create <sandboxId>")
    .description("Save a sandbox's disk under a name. COSTS MONEY: the first day is charged now.")
    .requiredOption("--name <name>", "1 to 64 letters, digits, spaces, dots, dashes or underscores")
    .option("--wait", "Wait until it is ready")
    .option("--json", "Print the raw JSON response")
    .action(async (sandboxId, opts) => {
      const api = await buildApi()
      try {
        let { snapshot } = await api.post<{ snapshot: any }>("/v1/sandbox-snapshots", {
          sandboxId,
          name: opts.name,
        })
        if (opts.wait) snapshot = await waitForSnapshot(api, snapshot.id)
        if (opts.json) return print({ snapshot })
        if (snapshot.status === "ready") {
          ui.success(`Snapshot ${snapshot.id} is ready. Start from it: ${cli(`sandboxes create --from ${snapshot.id}`)}`)
          return
        }
        ui.success(`Saving ${snapshot.id}.`)
        ui.hint(`It is ready when \`${cli(`sandboxes snapshots get ${snapshot.id}`)}\` says so.`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("delete <snapshotId>")
    .description("Delete it and stop its daily charge. Its share code stops working.")
    .action(async (snapshotId) => {
      const api = await buildApi()
      try {
        await api.del(`/v1/sandbox-snapshots/${encodeURIComponent(snapshotId)}`)
        ui.success(`Deleted ${snapshotId}`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("share <snapshotId>")
    .description("Print a share code another team can start sandboxes from.")
    .action(async (snapshotId) => {
      const api = await buildApi()
      try {
        const res = await api.post<{ snapshot: { shareCode: string } }>(
          `/v1/sandbox-snapshots/${encodeURIComponent(snapshotId)}/share`
        )
        process.stdout.write(`${res.snapshot.shareCode}\n`)
        ui.hint("Whoever holds it can copy this disk. Revoke it with `unshare`.")
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("unshare <snapshotId>")
    .description("Revoke the share code at once.")
    .action(async (snapshotId) => {
      const api = await buildApi()
      try {
        await api.del(`/v1/sandbox-snapshots/${encodeURIComponent(snapshotId)}/share`)
        ui.success("Share code revoked.")
      } catch (err) {
        fail(errMsg(err))
      }
    })

  return cmd
}

function environmentsCommand(): Command {
  const cmd = new Command("environments").description(
    "Named sets of variables to start sandboxes with. Values are never shown back."
  )

  const show = (env: any) => {
    ui.info(`${env.name} (${env.id})`)
    if (env.variables?.length) {
      ui.table(env.variables.map((v: any) => ({ key: v.key, value: `…${v.last4}` })))
    }
  }

  cmd
    .command("list")
    .description("This project's environments.")
    .option("--limit <n>", "Page size", "20")
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ items: any[]; nextCursor?: string | null }>("/v1/sandbox-environments", {
          limit: opts.limit,
          cursor: opts.cursor,
        })
        if (opts.json) return print(res)
        if (!res.items?.length) {
          ui.info(`No environments. Create one: ${cli("sandboxes environments create <name> --env KEY=value")}`)
          return
        }
        ui.table(
          res.items.map((e) => ({ id: e.id, name: e.name, variables: String(e.variables?.length ?? 0) }))
        )
        if (res.nextCursor) ui.hint(`More: --cursor ${res.nextCursor}`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("get <environmentId>")
    .description("Its variables, with the last four characters of each value.")
    .option("--json", "Print the raw JSON response")
    .action(async (environmentId, opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ environment: any }>(
          `/v1/sandbox-environments/${encodeURIComponent(environmentId)}`
        )
        if (opts.json) return print(res)
        show(res.environment)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("create <name>")
    .description("Create an environment.")
    .option("--env <KEY=value>", "A variable. Repeat for each.", collectRepeatable)
    .action(async (name, opts) => {
      let env: Record<string, string> | undefined
      try {
        env = parseEnv(opts.env)
      } catch (err) {
        fail(errMsg(err))
      }
      const api = await buildApi()
      try {
        const res = await api.post<{ environment: any }>("/v1/sandbox-environments", {
          name,
          ...(env ? { env } : {}),
        })
        ui.success("Created.")
        show(res.environment)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("update <environmentId>")
    .description("Rename it, add or replace variables, or remove them. Others keep their values.")
    .option("--name <name>", "New name")
    .option("--env <KEY=value>", "Add or replace a variable. Repeat for each.", collectRepeatable)
    .option("--unset <KEY>", "Remove a variable. Repeat for each.", collectRepeatable)
    .action(async (environmentId, opts) => {
      let env: Record<string, string> | undefined
      try {
        env = parseEnv(opts.env)
      } catch (err) {
        fail(errMsg(err))
      }
      if (!opts.name && !env && !opts.unset?.length) fail("Pass --name, --env or --unset.")
      const api = await buildApi()
      try {
        const res = await api.patch<{ environment: any }>(
          `/v1/sandbox-environments/${encodeURIComponent(environmentId)}`,
          {
            ...(opts.name ? { name: opts.name } : {}),
            ...(env ? { env } : {}),
            ...(opts.unset?.length ? { unset: opts.unset } : {}),
          }
        )
        ui.success("Updated.")
        show(res.environment)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("delete <environmentId>")
    .description("Delete it. Sandboxes already started with it keep their variables.")
    .action(async (environmentId) => {
      const api = await buildApi()
      try {
        await api.del(`/v1/sandbox-environments/${encodeURIComponent(environmentId)}`)
        ui.success(`Deleted ${environmentId}`)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  return cmd
}
