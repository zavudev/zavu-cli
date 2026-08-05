// Identity derivation for `deploy`'s first-deploy path.
//
// This exists because a project that already holds code was, until recently,
// undeployable: `init` refuses a non-empty directory and `import` only speaks
// GitHub, so an eve project you authored locally had no door. `deploy` now
// registers it, and registration needs a name and a slug that nobody was asked
// for. Getting those wrong is how a customer ends up with a function called
// after a temp directory.

import { describe, it, expect } from "vitest"
import { deriveFunctionIdentity, slugify, bumpSlug } from "../registerFunction"

describe("deriveFunctionIdentity", () => {
  it("prefers the explicit flags over everything else", () => {
    expect(
      deriveFunctionIdentity({
        flagName: "Returns Desk",
        flagSlug: "custom-slug",
        pkgName: "bramble-returns",
        dirName: "tmp-x1y2",
      })
    ).toEqual({ name: "Returns Desk", slug: "custom-slug" })
  })

  it("falls back to package.json's name before the directory", () => {
    expect(
      deriveFunctionIdentity({ pkgName: "bramble-returns", dirName: "tmp-x1y2" })
    ).toEqual({ name: "bramble-returns", slug: "bramble-returns" })
  })

  it("uses the directory when there is no package.json name", () => {
    expect(deriveFunctionIdentity({ dirName: "returns-agent" })).toEqual({
      name: "returns-agent",
      slug: "returns-agent",
    })
  })

  it("derives the slug from the name even when the name is a scoped package", () => {
    // Reusing an npm name verbatim would produce "@acme/returns-agent", which
    // is not a legal slug and would be rejected server-side after the compile.
    expect(deriveFunctionIdentity({ pkgName: "@acme/returns-agent", dirName: "x" }).slug).toBe(
      "acme-returns-agent"
    )
  })

  it("derives the slug from an explicit name, not from package.json", () => {
    expect(
      deriveFunctionIdentity({ flagName: "Clínica Aurora", pkgName: "clinica-agenda", dirName: "x" })
    ).toEqual({ name: "Clínica Aurora", slug: "clinica-aurora" })
  })

  it("returns an empty slug when the name has nothing sluggable, so the caller can refuse", () => {
    // Silently registering something unnamed is worse than telling the user to
    // pass --slug.
    expect(deriveFunctionIdentity({ flagName: "***", dirName: "x" }).slug).toBe("")
  })
})

describe("slug budget", () => {
  it("caps the slug so the server can still build a Lambda name", () => {
    expect(slugify("a-very-long-function-name-that-keeps-going").length).toBeLessThanOrEqual(20)
  })

  it("keeps a bumped slug inside the same budget", () => {
    expect(bumpSlug("a-very-long-function-name-that-keeps-going", 12).length).toBeLessThanOrEqual(23)
  })

  it("never leaves a trailing hyphen after truncating", () => {
    expect(slugify("returns desk for bramble plants")).not.toMatch(/-$/)
    expect(bumpSlug("returns-desk-for-bramble", 2)).not.toMatch(/--/)
  })
})
