import { describe, expect, it } from "vitest";
import {
  getSupportedTrackerKinds,
  resolveTrackerAdapter,
} from "./tracker-adapters.js";

describe("resolveTrackerAdapter", () => {
  it("registers the file adapter", () => {
    const adapter = resolveTrackerAdapter({
      adapter: "file",
      bindingId: "file-tracker",
      settings: {
        issuesPath: "/tmp/issues.json",
      },
    });

    expect(adapter.buildWorkerEnvironment).toBeTypeOf("function");
  });
});

it("exports adapter-owned tracker kinds for workflow validation", () => {
  expect(getSupportedTrackerKinds()).toEqual(
    expect.arrayContaining(["github-project", "file"])
  );
});
