/**
 * `--requirement <requirementId>=<value>` pairs for `phone-numbers buy`.
 *
 * The id is a `requirementTypes[].id` from `phone-numbers requirements`; the
 * value is text, or the id of an address or document created beforehand. Only
 * the first `=` separates them, because a text value may contain one.
 */
export class RequirementPairError extends Error {}

export type RequirementPair = { requirementType: string; fieldValue: string }

export function parseRequirementPairs(raw: string[] | undefined): RequirementPair[] {
  const pairs: RequirementPair[] = []
  const seen = new Set<string>()
  for (const entry of raw ?? []) {
    const at = entry.indexOf("=")
    const requirementType = at > 0 ? entry.slice(0, at).trim() : ""
    const fieldValue = at > 0 ? entry.slice(at + 1).trim() : ""
    if (!requirementType || !fieldValue) {
      throw new RequirementPairError(
        `Invalid --requirement "${entry}". Use <requirementId>=<value>.`
      )
    }
    if (seen.has(requirementType)) {
      throw new RequirementPairError(
        `--requirement ${requirementType} was given more than once. Pass one value per requirement.`
      )
    }
    seen.add(requirementType)
    pairs.push({ requirementType, fieldValue })
  }
  return pairs
}

/** Repeatable commander option collector. */
export function collectRepeatable(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}
