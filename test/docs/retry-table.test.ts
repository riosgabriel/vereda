import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEFAULT_RETRY_ON_STATUS } from "../../src/core/types.js"

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8")

describe("README retry table", () => {
  it("documents what gets retried and matches DEFAULT_RETRY_ON_STATUS", () => {
    const heading = "#### What gets retried"
    expect(README).toContain(heading)

    // Slice from the heading to the next line starting with a heading marker
    const headingIndex = README.indexOf(heading)
    const rest = README.slice(headingIndex)
    const nextHeading = rest.search(/\n#/)
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading)

    // Find the retryable_status row and parse its backtick-quoted status list
    const row = section.split("\n").find((line) => line.includes("`retryable_status`"))
    expect(row).toBeDefined()
    const listMatch = row!.match(/`([^`]+)`/)
    expect(listMatch).not.toBeNull()
    const statuses = listMatch![1].split(",").map((s) => Number(s.trim()))
    expect(statuses).toEqual(DEFAULT_RETRY_ON_STATUS)

    // Guard the Idempotency-Key opt-in row surviving edits
    expect(section).toContain("Idempotency-Key")
  })
})
