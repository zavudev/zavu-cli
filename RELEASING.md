# Releasing the `zavudev` CLI

The CLI is developed in the Zavu monorepo (`packages/zavu-cli`) and published
from its public mirror, [zavudev/zavu-cli](https://github.com/zavudev/zavu-cli).
A new version goes to npm when it reaches `main`. You only pick the version.

```
pull request in zavudev/zavu (packages/zavu-cli)
  -> CI: tests, standalone build, version bumped
  -> merge to main
  -> sync-cli.yml mirrors the folder to zavudev/zavu-cli main
  -> its release.yml publishes to npm with provenance, tags cli-v<version>, creates a GitHub Release
```

## Shipping a change

1. Change the CLI in a pull request.
2. If a file that ends up in the package changed (`src/` outside the tests,
   `package.json`, `bun.lock`, `README.md`, `CHANGELOG.md`), set a version npm
   does not have yet in `package.json` and move the `[Unreleased]` entries
   under `## [<version>]` in `CHANGELOG.md`. The `CLI version bumped` check
   enforces both. Read the changelog rules in `CLAUDE.md` first: it ships.
3. Merge. Nothing else is needed: `npx zavudev@latest` resolves the new
   version a minute or two later.

A version with a pre-release part (`0.16.0-beta.1`) is published under the
`next` dist-tag instead of `latest`.

## The lockfile

`bun.lock` in this folder is the package's own, used only by the mirror, which
installs and builds outside the monorepo. The monorepo's root `bun.lock` is
what `bun install` uses here. After changing a dependency in `package.json`,
regenerate this one outside the workspace:

```sh
tmp="$(mktemp -d)"
git archive HEAD packages/zavu-cli | tar -x -C "$tmp" --strip-components=2
cp packages/zavu-cli/package.json "$tmp/"
(cd "$tmp" && bun install)
cp "$tmp/bun.lock" packages/zavu-cli/bun.lock
```

The `CLI` job in CI does the same install with `--frozen-lockfile` and fails
when the two disagree.

## What the mirror runs

`release.yml` installs from `bun.lock`, builds, checks that
`zavudev --version` prints the version in `package.json` (the build inlines the
manifest), and publishes unless npm already has that version. It does not run
the test suite: several tests read files that exist only in the monorepo, and
the monorepo's `CLI` job runs all of them before anything is merged.

Re-running a release is safe: a version npm already has is skipped, and an
existing GitHub Release is left alone. To run it by hand, open
**Actions → Release → Run workflow** in zavu-cli on `main`. It is a dry run
(`npm publish --dry-run`) unless you untick `dry-run`.

Never commit to zavu-cli directly: the sync stops when that repository has
commits that did not come from here (`scripts/sync-sdk.sh` explains how to
recover).

## One-time setup

1. **GitHub App.** The release App (the one the SDK sync uses, with the
   secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`) must be installed on
   zavudev/zavu-cli with Contents and Workflows write. Without Workflows,
   GitHub refuses a push that adds `.github/workflows/release.yml`.
2. **First sync.** zavu-cli's `main` predates the mirror, so the sync would
   stop as diverged. Mark it as synced once (a fast-forward, no force):

   ```sh
   git fetch https://github.com/zavudev/zavu-cli.git main
   git push https://github.com/zavudev/zavu-cli.git FETCH_HEAD:refs/mirror/last-sync
   ```

   The next sync then joins that `main` to this folder with a commit whose tree
   is exactly the folder.
3. **npm trusted publishing (OIDC).** No npm token. On npmjs.com, signed in
   as an owner of `zavudev`, open the package → Settings → Trusted publishing
   and add a GitHub Actions publisher:

   - Organization or user: `zavudev`
   - Repository: `zavu-cli`
   - Workflow filename: `release.yml`
   - Environment: empty

   Provenance needs `repository.url` in `package.json` to be this repository,
   which it is. Once a release has gone out this way, set the package's
   publishing access to "Require two-factor authentication and disallow
   tokens".
