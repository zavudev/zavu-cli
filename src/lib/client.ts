// Builds an authenticated SDK client from saved credentials.
// Throws a friendly "run zavu login" error if credentials are missing.

import Zavudev from "@zavudev/sdk"
import { readCredentials } from "./config"
import { fail } from "./ui"

export async function buildClient(): Promise<Zavudev> {
  const creds = await readCredentials()
  if (!creds?.apiKey) {
    fail("Not logged in. Run `zavu login` first.")
  }
  return new Zavudev({
    apiKey: creds!.apiKey,
    baseURL: creds!.apiBaseUrl,
  })
}
