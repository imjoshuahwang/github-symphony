import { describe, expect, it } from "vitest";
import { parseBuiltInMcpServer } from "./mcp-server.js";

describe("parseBuiltInMcpServer", () => {
  it.each([
    [["--server", "github"], "github"],
    [["--server=github"], "github"],
  ] as const)("selects %s", (args, expected) => {
    expect(parseBuiltInMcpServer([...args])).toBe(expected);
  });

  it("rejects missing and unsupported server selections", () => {
    expect(() => parseBuiltInMcpServer([])).toThrow("Expected --server github");
    expect(() => parseBuiltInMcpServer(["--server", "other"])).toThrow(
      "received other"
    );
  });
});
