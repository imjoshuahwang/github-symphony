import { describe, expect, it } from "vitest";
import { parseReviewVerdict } from "./review-verdict.js";
import { stateLabel } from "./state-label.js";

describe("parseReviewVerdict", () => {
  it("parses approve", () => {
    expect(parseReviewVerdict("Looks good.\nDECISION: approve\n")).toEqual({
      decision: "approve",
      findings: "",
    });
  });

  it("parses request_changes with a findings block", () => {
    expect(
      parseReviewVerdict(
        "DECISION: request_changes\nFINDINGS:\n- missing test\n- typo in README\n"
      )
    ).toEqual({
      decision: "request_changes",
      findings: "- missing test\n- typo in README",
    });
  });

  it("parses needs_human", () => {
    expect(
      parseReviewVerdict("DECISION: needs_human\nFINDINGS: touches billing")
    ).toEqual({ decision: "needs_human", findings: "touches billing" });
  });

  it("uses the last decision line", () => {
    const verdict = parseReviewVerdict(
      "Format: DECISION: approve\nDECISION: approve\nFINDINGS: early\nDECISION: request_changes\nFINDINGS: late"
    );
    expect(verdict).toEqual({ decision: "request_changes", findings: "late" });
  });

  it.each(["", "DECISION: ship-it", "I think this is fine"])(
    "fails safe on malformed output %j",
    (text) => {
      expect(parseReviewVerdict(text)).toEqual({
        decision: "request_changes",
        findings: "reviewer output malformed",
        malformed: true,
      });
    }
  );
});

describe("stateLabel", () => {
  it("slugifies state names with a default prefix", () => {
    expect(stateLabel("In code review")).toBe("symphony:in-code-review");
    expect(stateLabel(" Done! ", "sym/")).toBe("sym/done");
  });
});
