import { describe, it, expect } from "vitest"
import {
  collectRepeatable,
  parseRequirementPairs,
  RequirementPairError,
} from "../phoneNumberRequirements"

// A pair split on the wrong "=" sends the wrong value under the right id, and
// the purchase is refused for a reason the user cannot see in their command.

describe("parseRequirementPairs", () => {
  it("splits on the first = only", () => {
    expect(parseRequirementPairs(["req_1=addr_123", "req_2=Acme = Co"])).toEqual([
      { requirementType: "req_1", fieldValue: "addr_123" },
      { requirementType: "req_2", fieldValue: "Acme = Co" },
    ])
  })

  it("returns nothing when no pair is given", () => {
    expect(parseRequirementPairs(undefined)).toEqual([])
  })

  it("refuses a pair without an id or a value", () => {
    expect(() => parseRequirementPairs(["=value"])).toThrow(RequirementPairError)
    expect(() => parseRequirementPairs(["req_1="])).toThrow(RequirementPairError)
    expect(() => parseRequirementPairs(["req_1"])).toThrow(RequirementPairError)
  })

  it("refuses the same id twice", () => {
    expect(() => parseRequirementPairs(["req_1=a", "req_1=b"])).toThrow(/more than once/)
  })
})

describe("collectRepeatable", () => {
  it("accumulates repeated flags", () => {
    expect(collectRepeatable("b", collectRepeatable("a"))).toEqual(["a", "b"])
  })
})
