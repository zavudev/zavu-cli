// Credentials and project-link config storage.
//
// Two layers:
//   ~/.zavu/credentials.json  — global, machine-wide. Stores the API key used
//                               for every Zavu API call. Written by `zavu login`.
//   ./.zavu/config.json       — per-project, in the function's source dir.
//                               Stores projectId / functionId / slug.
//                               Written by `zavu init` and read by `zavu deploy`.

import { homedir } from "node:os"
import { join } from "node:path"
import { readFile, writeFile, mkdir, access, unlink } from "node:fs/promises"

const HOME_CONFIG_DIR = join(homedir(), ".zavu")
const CREDENTIALS_PATH = join(HOME_CONFIG_DIR, "credentials.json")
const PROJECT_CONFIG_DIR = ".zavu"
const PROJECT_CONFIG_FILENAME = "config.json"

export interface GlobalCredentials {
  apiKey: string
  apiBaseUrl: string
  // Optional: which deployment of Convex the user is targeting (dev / prod).
  // Defaults to https://api.zavu.dev when not set.
  environment?: "dev" | "prod"
  updatedAt: string
}

export interface ProjectConfig {
  projectId: string
  functionId: string
  slug: string
  name: string
  // Resolved at `zavu init` time. Lets `zavu deploy` skip a roundtrip
  // to the API to discover the public URL after publishing.
  publicUrl?: string
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function readCredentials(): Promise<GlobalCredentials | null> {
  if (!(await fileExists(CREDENTIALS_PATH))) return null
  const raw = await readFile(CREDENTIALS_PATH, "utf8")
  try {
    return JSON.parse(raw) as GlobalCredentials
  } catch {
    return null
  }
}

/**
 * Credentials for this run, preferring the environment over the saved file.
 *
 * `ZAVUDEV_API_KEY` (with optional `ZAVUDEV_API_BASE_URL`) lets a container, a
 * CI job, or a coding agent authenticate without an interactive `zavu login`
 * and without a writable home directory. The docs have promised this for a
 * while; only `login` actually read it, so every other command still demanded
 * the file and died with "Not logged in" in exactly the environments this is
 * for.
 */
export async function resolveCredentials(): Promise<GlobalCredentials | null> {
  const envKey = process.env.ZAVUDEV_API_KEY?.trim()
  if (envKey) {
    return {
      apiKey: envKey,
      apiBaseUrl:
        process.env.ZAVUDEV_API_BASE_URL?.trim() || "https://api.zavu.dev",
      updatedAt: new Date().toISOString(),
    }
  }
  return readCredentials()
}

export async function writeCredentials(creds: GlobalCredentials): Promise<void> {
  await mkdir(HOME_CONFIG_DIR, { recursive: true, mode: 0o700 })
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 })
}

export async function clearCredentials(): Promise<void> {
  if (await fileExists(CREDENTIALS_PATH)) await unlink(CREDENTIALS_PATH)
}

export async function readProjectConfig(cwd = process.cwd()): Promise<ProjectConfig | null> {
  const path = join(cwd, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME)
  if (!(await fileExists(path))) return null
  const raw = await readFile(path, "utf8")
  try {
    return JSON.parse(raw) as ProjectConfig
  } catch {
    return null
  }
}

export async function writeProjectConfig(
  config: ProjectConfig,
  cwd = process.cwd()
): Promise<void> {
  const dir = join(cwd, PROJECT_CONFIG_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, PROJECT_CONFIG_FILENAME),
    JSON.stringify(config, null, 2),
    { mode: 0o644 }
  )
}

export function credentialsPath(): string {
  return CREDENTIALS_PATH
}
