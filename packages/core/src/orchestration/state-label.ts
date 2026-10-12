/** Maps a workflow state name to its tracker label, e.g. "In code review" -> "symphony:in-code-review". */
export function stateLabel(stateName: string, prefix = "symphony:"): string {
  const slug = stateName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}${slug}`;
}
