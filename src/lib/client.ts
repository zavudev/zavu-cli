// Builds an authenticated SDK client from saved credentials.
// Throws a friendly "run zavu login" error if credentials are missing.

import Zavudev from "@zavudev/sdk"
import { resolveCredentials } from "./config"
import { fail } from "./ui"

export async function buildClient(): Promise<Zavudev> {
  const creds = await resolveCredentials()
  if (!creds?.apiKey) {
    fail(
      "Not logged in. Run `zavu login`, or set ZAVUDEV_API_KEY for a non-interactive environment.",
    )
  }
  return new Zavudev({
    apiKey: creds!.apiKey,
    baseURL: creds!.apiBaseUrl,
  })
}
