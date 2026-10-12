export type ReviewDecision = "approve" | "request_changes" | "needs_human";

export type ReviewVerdict = {
  decision: ReviewDecision;
  findings: string;
  malformed?: boolean;
};

const DECISION_LINE =
  /^\s*DECISION:\s*(approve|request_changes|needs_human)\s*$/gm;

/**
 * Parses reviewer output. The last `DECISION:` line wins; its findings are the
 * text after the following `FINDINGS:` marker. Anything unparseable fails safe
 * to request_changes so a garbled review can never approve a merge.
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  const matches = [...(text ?? "").matchAll(DECISION_LINE)];
  const last = matches.at(-1);
  if (!last) {
    return {
      decision: "request_changes",
      findings: "reviewer output malformed",
      malformed: true,
    };
  }

  const rest = text.slice(last.index + last[0].length);
  const findingsMatch = /^\s*FINDINGS:[^\S\n]*/m.exec(rest);
  return {
    decision: last[1] as ReviewDecision,
    findings: findingsMatch
      ? rest.slice(findingsMatch.index + findingsMatch[0].length).trim()
      : "",
  };
}
