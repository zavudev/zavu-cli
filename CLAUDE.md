# CLAUDE.md: zavu-cli

Guidance for working on the `zavudev` CLI. This package is **published to npm and
installed on customer machines**, so its changelog, its help text, and its error
messages are public surface. Treat them as such.

The repo-wide rules in the root `CLAUDE.md` still apply. This file adds what is
specific to shipping a public binary.

## Changelog policy

`CHANGELOG.md` is read by customers, not by us. It answers one question: **what
changed for the person using the CLI, and do they need to do anything?**

### Write

- The observable behavior, before and after. "`login` did not exit after
  reporting success. It now exits as soon as the token is stored."
- The action the user must take, if any. Rotate a key, re-run a command,
  reinstall, check a file.
- Breaking changes, loudly, with the migration.
- New commands and flags.

### Never write

- **Root causes and internal mechanisms.** Not the function that was wrong, not
  the file, not the missing `await`, not the flag on the build tool, not the
  race in the deploy step. "Fixed" plus the observable symptom is the whole
  entry. Our bug taxonomy is not a customer's business and reads as instability.
- **Release, CI, and build tooling.** The sync, the GitHub Actions, the npm
  publish step, the tagging flow. If a botched release meant a version shipped
  wrong, the customer-facing fact is "0.9.2 reported the wrong `--version`; it is
  correct in 0.9.3." Nothing about how.
- **Provider names.** Repo-wide rule: never name the carrier, telephony, or
  infrastructure vendors behind a channel. This includes changelog entries,
  error strings, and `--help`.
- **Internal identifiers.** Convex deployment names, internal URLs, dashboards,
  env var names that are not part of the public contract, internal repo names,
  table names, ticket IDs.
- **Self-flagellation.** No "this had been broken since 0.6", no "we should have
  caught this", no apologies. State the change and move on.
- **Anything you have not verified.** An entry you inferred is worse than no
  entry.

### Security fixes are the exception, partly

A security fix **must** be disclosed when the user has to act. Someone whose
credentials may have leaked needs to know, and burying it is the real harm.

Disclose: the impact, the affected versions, and the remedy. "Versions 0.7.0 to
0.7.4 scaffolded projects whose `.gitignore` did not cover `.env`. If you
committed one, rotate the keys it held."

Still do not disclose: the exploit path, the internal mechanism, or anything that
helps someone attack a user who has not upgraded yet.

### Wording

Past tense for the old behavior, present for the new. No em-dashes or en-dashes
(period, comma, or colon instead; hyphen only for ranges). No emojis. Short and
editorial, matching the Zavu voice.

## Security invariants

These are load-bearing. Do not regress them, and do not "simplify" them away.

- **Never print a full API key, token, or secret.** Last four characters only,
  as `…abcd`. This holds for success messages, debug output, error paths, and
  `--json`. The secrets API deliberately returns only `valueLast4`; do not build
  a command that reconstructs a plaintext secret.
- **`~/.zavu/credentials.json` is written with mode `0o600`.** Any new write path
  for credentials keeps that mode.
- **The login callback server binds `127.0.0.1` on a random port**, verifies the
  `state` nonce before accepting a token, and closes immediately after. Never
  bind `0.0.0.0`, never accept a callback without checking `state`, never leave
  the server listening.
- **Never log the request body of an authenticated call** without stripping
  credentials first. Scaffolded code and user source may contain secrets.
- **Scaffolds gitignore secrets.** If a template documents `.env`, the generated
  `.gitignore` covers `.env` and `.env.*` in the same change. Documenting a
  secrets file without ignoring it creates a path to committing credentials.
- **User source leaves the machine only via the deploy endpoint.** No telemetry,
  no analytics, no error reporting that ships code, paths, or environment.
- **Warn when not pointed at production.** A CLI silently talking to a dev
  deployment produces "the backend does not support this" reports that are
  really misconfiguration. Keep `warnIfNotProduction`.

## Errors and help text

Public surface, same rules as the changelog.

- Say what to do next, in the user's terms. Not "reconcile failed", but what
  they should run.
- Never leak internals in an error: no stack traces from the backend, no Convex
  internals, no provider names, no internal URLs.
- When the server rejects something the CLI supports, say **which** server. A
  version skew between CLI and API reads as a missing feature otherwise.

## Before a release

- `--version` matches `package.json`. The build inlines the manifest, so this is
  only true because of `prepack`. Do not remove it.
- Bump `version` in `package.json` in the same pull request, and move the
  `[Unreleased]` entries under `## [<version>]`. The `CLI version bumped` check
  fails without both. Merging to `main` publishes it; nothing else does. See
  `RELEASING.md`.
- Changed a dependency? Regenerate `bun.lock` here (it is this package's own,
  used by the public mirror) as `RELEASING.md` says, or the `CLI` check fails.
- Re-read the new entries against "Never write" above.
- `CHANGELOG.md` is in the package `files` array, so whatever you wrote ships.
