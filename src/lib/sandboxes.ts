/**
 * Pure helpers for `zavudev sandboxes`: turning flags into request bodies.
 * Kept apart from the command so they can be tested without the network.
 */

export class SandboxFlagError extends Error {}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const METADATA_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/**
 * `KEY=value` pairs from a repeatable flag. Only the first `=` separates them,
 * because a value (a URL, a connection string) often contains one.
 */
export function parseKeyValues(
  raw: string[] | undefined,
  flag: string,
  keyPattern: RegExp = ENV_KEY
): Record<string, string> | undefined {
  if (!raw?.length) return undefined
  const out: Record<string, string> = {}
  for (const entry of raw) {
    const at = entry.indexOf("=")
    const key = at > 0 ? entry.slice(0, at) : ""
    if (!key) throw new SandboxFlagError(`Invalid ${flag} "${entry}". Use KEY=value.`)
    if (!keyPattern.test(key)) {
      throw new SandboxFlagError(`Invalid ${flag} key "${key}".`)
    }
    if (key in out) {
      throw new SandboxFlagError(`${flag} ${key} was given more than once.`)
    }
    out[key] = entry.slice(at + 1)
  }
  return out
}

export function parseMetadata(raw: string[] | undefined): Record<string, string> | undefined {
  return parseKeyValues(raw, "--metadata", METADATA_KEY)
}

export function parseEnv(raw: string[] | undefined): Record<string, string> | undefined {
  return parseKeyValues(raw, "--env")
}

/**
 * `--timeout <seconds>` or `--no-timeout`. Commander gives `false` for the
 * negated flag, a string for the value, and `true` (its default for a
 * `--no-` pair) when neither was passed.
 */
export function parseTimeout(raw: string | boolean | undefined): number | null | undefined {
  if (raw === false) return null
  if (raw === undefined || raw === true) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 60 || n > 86400) {
    throw new SandboxFlagError("--timeout is a whole number of seconds from 60 to 86400.")
  }
  return n
}

export interface CreateFlags {
  size?: string
  timeout?: string | boolean
  ephemeral?: boolean
  name?: string
  env?: string[]
  environment?: string
  from?: string
  metadata?: string[]
  idempotencyKey?: string
}

const SIZES = new Set(["small", "default", "large"])

export function buildCreateBody(flags: CreateFlags, setupScript?: string): Record<string, unknown> {
  if (flags.size && !SIZES.has(flags.size)) {
    throw new SandboxFlagError("--size is small, default or large.")
  }
  const body: Record<string, unknown> = {}
  if (flags.size) body.size = flags.size
  const timeout = parseTimeout(flags.timeout)
  if (timeout !== undefined) body.timeoutSeconds = timeout
  if (flags.ephemeral) body.ephemeral = true
  if (flags.name) body.name = flags.name
  const env = parseEnv(flags.env)
  if (env) body.env = env
  if (flags.environment) body.environment = flags.environment
  if (flags.from) body.from = flags.from
  const metadata = parseMetadata(flags.metadata)
  if (metadata) body.metadata = metadata
  if (flags.idempotencyKey) body.idempotencyKey = flags.idempotencyKey
  if (setupScript !== undefined) body.setupScript = setupScript
  return body
}

/** A sandbox's `costTotal`, in USD. */
export function formatCost(usd: unknown): string {
  return typeof usd === "number" ? `$${usd.toFixed(4)}` : "—"
}
