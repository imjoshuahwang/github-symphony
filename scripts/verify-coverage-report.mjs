import { readFile } from "node:fs/promises";

const report = JSON.parse(
  await readFile(
    new URL("../coverage/coverage-final.json", import.meta.url),
    "utf8"
  )
);
const sourceEntries = Object.entries(report).filter(([file]) =>
  file.includes("/packages/")
);
const coveredStatements = sourceEntries.reduce(
  (count, [, coverage]) =>
    count + Object.values(coverage.s).filter((hits) => hits > 0).length,
  0
);

if (sourceEntries.length === 0 || coveredStatements === 0) {
  console.error("Aggregate coverage contains no covered package source.");
  process.exit(1);
}

console.log(
  `Aggregate coverage includes ${sourceEntries.length} package files with ${coveredStatements} covered statements.`
);
