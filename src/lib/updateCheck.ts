// Tells you when the CLI you are running is behind the published one.
//
// A CLI four minors old reports "the API does not support this" for features
// that shipped weeks ago, and nothing about the terminal says why. That is not
// hypothetical: an install path went stale at 0.5.0 while npm was on 0.9.4, and
// the people using it had no signal at all. `npx zavudev@latest` avoids this by
// construction, but a global install can drift the same way.
//
// Runs only on `--version`, never on a real command: no network call gets in
// the way of doing work, and a failed check is silent.

const REGISTRY_URL = "https://registry.npmjs.org/zavudev/latest"
const TIMEOUT_MS = 1500

/** true when `latest` is newer than `current` under semver ordering. */
export function isOutdated(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0)

  const [a, b] = [parse(current), parse(latest)]
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false
  }
  return false
}

/**
 * The published version, or null when it cannot be determined quickly.
 *
 * Every failure path returns null on purpose: being offline, behind a proxy, or
 * rate-limited must never turn `--version` into an error.
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const body = (await res.json()) as { version?: string }
    return body.version ?? null
  } catch {
    return null
  }
}

/** Prints an upgrade hint to stderr when a newer version exists. */
export async function warnIfOutdated(current: string): Promise<void> {
  const latest = await fetchLatestVersion()
  if (!latest || !isOutdated(current, latest)) return

  // stderr so `zavu --version` piped into a script still yields just the number.
  process.stderr.write(
    `\nA newer version is available: ${current} → ${latest}\n` +
      `  npx zavudev@latest <command>   (always current, nothing to install)\n` +
      `  npm install -g zavudev@latest  (if you installed globally)\n`
  )
}
