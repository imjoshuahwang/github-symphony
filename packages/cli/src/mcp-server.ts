import { runGitHubGraphQLMcpServer } from "@gh-symphony/tool-github-graphql";

export type BuiltInMcpServer = "github";

export function parseBuiltInMcpServer(args: string[]): BuiltInMcpServer {
  const serverFlagIndex = args.indexOf("--server");
  const inlineServer = args
    .find((arg) => arg.startsWith("--server="))
    ?.slice("--server=".length);
  const server =
    serverFlagIndex === -1 ? inlineServer : args[serverFlagIndex + 1];

  if (server === "github") {
    return server;
  }

  throw new Error(
    `Expected --server github when starting the built-in MCP server, received ${server ?? "nothing"}.`
  );
}

export async function runBuiltInMcpServer(args: string[]): Promise<void> {
  parseBuiltInMcpServer(args);
  await runGitHubGraphQLMcpServer();
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runBuiltInMcpServer(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
