import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "@gh-symphony/core";
import {
  mergeGithubPullRequest,
  requestGithubProjectItemState,
  setGithubIssueStateLabel,
  resetGitHubRateLimitCacheForTests,
  type GitHubTrackerConfig,
} from "./adapter.js";

const config: GitHubTrackerConfig = {
  projectId: "project-1",
  token: "token-1",
};

afterEach(() => {
  resetGitHubRateLimitCacheForTests();
  vi.restoreAllMocks();
});

describe("requestGithubProjectItemState", () => {
  it("serializes five exact-item transitions without listing the board", async () => {
    const states = new Map(
      Array.from({ length: 5 }, (_, index) => [
        `item-${index + 1}`,
        "In progress",
      ])
    );
    const seenQueries: string[] = [];
    const seenItemIds: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        seenQueries.push(body.query);
        if (body.variables.itemId) {
          seenItemIds.push(body.variables.itemId);
        }
        const response = graphqlResponse(body.query, body.variables, states);
        inFlight -= 1;
        return response;
      }
    ) as typeof fetch;

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        requestGithubProjectItemState(
          config,
          {
            issueSubjectId: `issue-${index + 1}`,
            itemId: `item-${index + 1}`,
            request: {
              type: "transition-request",
              expectedState: "In progress",
              targetState: "In review",
              reason: `worker ${index + 1} completed`,
            },
          },
          fetchImpl
        )
      )
    );

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.every((result) => result.state === "In review")).toBe(true);
    expect(results.map((result) => result.rateLimits?.cycleCost)).toEqual([
      3, 2, 2, 2, 2,
    ]);
    expect(results[0]?.rateLimits?.queryCosts).toEqual({
      ExactProjectItemState: { requestCount: 2, cost: 2 },
      ProjectFields: { requestCount: 1, cost: 1 },
    });
    for (const result of results.slice(1)) {
      expect(result.rateLimits?.queryCosts).not.toHaveProperty("ProjectFields");
    }
    expect(maxInFlight).toBe(1);
    expect(seenQueries).toHaveLength(16);
    expect(seenQueries.join("\n")).not.toContain("query ProjectItems");
    expect(new Set(seenItemIds)).toEqual(
      new Set(["item-1", "item-2", "item-3", "item-4", "item-5"])
    );
  });

  it("queries the Status field by name without a field-value page limit", async () => {
    const states = new Map([["item-21", "In progress"]]);
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        if (body.query.includes("query ExactProjectItemState")) {
          expect(body.query).toContain("fieldValueByName");
          expect(body.query).not.toContain("fieldValues(first: 20)");
          expect(body.variables.stateFieldName).toBe("Status");
        }
        return graphqlResponse(body.query, body.variables, states);
      }
    ) as typeof fetch;

    const result = await requestGithubProjectItemState(
      config,
      {
        issueSubjectId: "issue-21",
        itemId: "item-21",
        request: { type: "state-read" },
      },
      fetchImpl
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: "confirmed",
      state: "In progress",
    });
  });

  it("trims the configured Status field name for exact-item readback", async () => {
    const states = new Map([["item-trimmed", "In progress"]]);
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        if (body.query.includes("query ExactProjectItemState")) {
          expect(body.variables.stateFieldName).toBe("Status");
        }
        return graphqlResponse(body.query, body.variables, states);
      }
    ) as typeof fetch;

    const result = await requestGithubProjectItemState(
      {
        ...config,
        lifecycle: {
          ...DEFAULT_WORKFLOW_LIFECYCLE,
          stateFieldName: " Status ",
        },
      },
      {
        issueSubjectId: "issue-trimmed",
        itemId: "item-trimmed",
        request: { type: "state-read" },
      },
      fetchImpl
    );

    expect(result).toMatchObject({ ok: true, state: "In progress" });
  });

  it("refreshes stale cached Status metadata after an invalid option mutation", async () => {
    const states = new Map([["item-1", "In progress"]]);
    let projectFieldRequests = 0;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        if (body.query.includes("query ProjectFields")) {
          projectFieldRequests += 1;
          return jsonResponse({
            data: {
              rateLimit: rateLimit(),
              node: {
                __typename: "ProjectV2",
                fields: {
                  nodes: [
                    {
                      __typename: "ProjectV2SingleSelectField",
                      id: "status-field",
                      name: "Status",
                      options: [
                        {
                          id: `in-review-${projectFieldRequests}`,
                          name: "In review",
                        },
                      ],
                    },
                  ],
                },
              },
            },
          });
        }
        if (
          body.query.includes("mutation UpdateProjectItemState") &&
          body.variables.optionId === "in-review-1"
        ) {
          return jsonResponse({
            errors: [{ message: "single select option not found" }],
          });
        }
        return graphqlResponse(body.query, body.variables, states);
      }
    ) as typeof fetch;

    const result = await requestGithubProjectItemState(
      config,
      {
        issueSubjectId: "issue-1",
        itemId: "item-1",
        request: {
          type: "transition-request",
          expectedState: "In progress",
          targetState: "In review",
          reason: "refresh stale metadata",
        },
      },
      fetchImpl
    );

    expect(result).toMatchObject({ ok: true, state: "In review" });
    expect(projectFieldRequests).toBe(2);
  });

  it("refreshes stale cached Status metadata after a global-ID mutation error", async () => {
    const states = new Map([["item-global-id", "In progress"]]);
    let projectFieldRequests = 0;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        if (body.query.includes("query ProjectFields")) {
          projectFieldRequests += 1;
          return jsonResponse({
            data: {
              rateLimit: rateLimit(),
              node: {
                __typename: "ProjectV2",
                fields: {
                  nodes: [
                    {
                      __typename: "ProjectV2SingleSelectField",
                      id: `status-field-${projectFieldRequests}`,
                      name: "Status",
                      options: [
                        {
                          id: `in-review-${projectFieldRequests}`,
                          name: "In review",
                        },
                      ],
                    },
                  ],
                },
              },
            },
          });
        }
        if (
          body.query.includes("mutation UpdateProjectItemState") &&
          body.variables.fieldId === "status-field-1"
        ) {
          return jsonResponse({
            errors: [
              {
                message:
                  "Could not resolve to a node with the global id of 'PVTSSF_stale'",
              },
            ],
          });
        }
        return graphqlResponse(body.query, body.variables, states);
      }
    ) as typeof fetch;

    const result = await requestGithubProjectItemState(
      config,
      {
        issueSubjectId: "issue-global-id",
        itemId: "item-global-id",
        request: {
          type: "transition-request",
          expectedState: "In progress",
          targetState: "In review",
          reason: "refresh stale global ID metadata",
        },
      },
      fetchImpl
    );

    expect(result).toMatchObject({ ok: true, state: "In review" });
    expect(projectFieldRequests).toBe(2);
  });

  it("rejects an expected-state mismatch before mutation", async () => {
    const states = new Map([["item-1", "Ready"]]);
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        return graphqlResponse(body.query, body.variables, states);
      }
    ) as typeof fetch;

    const result = await requestGithubProjectItemState(
      config,
      {
        issueSubjectId: "issue-1",
        itemId: "item-1",
        request: {
          type: "transition-request",
          expectedState: "In progress",
          targetState: "In review",
          reason: "handoff",
        },
      },
      fetchImpl
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: "expected_state_mismatch",
      state: "Ready",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a rate-limited mutation and confirms exact-item readback", async () => {
    const states = new Map([["item-1", "In progress"]]);
    let mutationAttempts = 0;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        if (body.query.includes("mutation UpdateProjectItemState")) {
          mutationAttempts += 1;
          if (mutationAttempts === 1) {
            return new Response("rate limit exceeded", {
              status: 429,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000)),
              },
            });
          }
        }
        return graphqlResponse(body.query, body.variables, states);
      }
    ) as typeof fetch;

    const result = await requestGithubProjectItemState(
      config,
      {
        issueSubjectId: "issue-1",
        itemId: "item-1",
        request: {
          type: "transition-request",
          expectedState: "In progress",
          targetState: "In review",
          reason: "handoff",
        },
      },
      fetchImpl
    );

    expect(mutationAttempts).toBe(2);
    expect(result).toMatchObject({
      ok: true,
      outcome: "confirmed",
      state: "In review",
    });
  });

  it("honors Retry-After before retrying a quota-limited mutation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T14:00:00.000Z"));
    const states = new Map([["item-1", "In progress"]]);
    let mutationAttempts = 0;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        if (body.query.includes("mutation UpdateProjectItemState")) {
          mutationAttempts += 1;
          if (mutationAttempts === 1) {
            return new Response("rate limit exceeded", {
              status: 429,
              headers: {
                "retry-after": "1",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000) + 1),
              },
            });
          }
        }
        return graphqlResponse(body.query, body.variables, states);
      }
    ) as typeof fetch;

    const resultPromise = requestGithubProjectItemState(
      config,
      {
        issueSubjectId: "issue-1",
        itemId: "item-1",
        request: {
          type: "transition-request",
          expectedState: "In progress",
          targetState: "In review",
          reason: "handoff",
        },
      },
      fetchImpl
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(mutationAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      outcome: "confirmed",
      state: "In review",
    });
    expect(mutationAttempts).toBe(2);
    vi.useRealTimers();
  });

  it("authorizes a PullRequest canonical project item", async () => {
    let seenQuery = "";
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        seenQuery = body.query;
        return jsonResponse({
          data: {
            rateLimit: rateLimit(),
            node: {
              __typename: "ProjectV2Item",
              id: "item-1",
              project: { id: "project-1" },
              content: { id: "pull-request-1" },
              fieldValueByName: statusFieldValue("In progress"),
            },
          },
        });
      }
    ) as typeof fetch;

    await expect(
      requestGithubProjectItemState(
        config,
        {
          issueSubjectId: "pull-request-1",
          itemId: "item-1",
          request: { type: "state-read" },
        },
        fetchImpl
      )
    ).resolves.toMatchObject({
      ok: true,
      outcome: "confirmed",
      state: "In progress",
    });
    expect(seenQuery).toContain("... on PullRequest");
  });

  it("rejects an exact item that does not belong to the run issue", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          rateLimit: rateLimit(),
          node: {
            __typename: "ProjectV2Item",
            id: "item-1",
            project: { id: "project-1" },
            content: { id: "different-issue" },
            fieldValues: { nodes: [statusFieldValue("In progress")] },
          },
        },
      })
    ) as typeof fetch;

    await expect(
      requestGithubProjectItemState(
        config,
        {
          issueSubjectId: "issue-1",
          itemId: "item-1",
          request: { type: "state-read" },
        },
        fetchImpl
      )
    ).rejects.toThrow("tracker_item_authorization_mismatch");
  });

  it("identifies the issue when strict exact-item state readback is missing Status", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          rateLimit: rateLimit(),
          node: {
            __typename: "ProjectV2Item",
            id: "item-1",
            project: { id: "project-1" },
            content: {
              id: "issue-1",
              number: 1,
              repository: { name: "platform", owner: { login: "acme" } },
            },
            fieldValues: { nodes: [] },
          },
        },
      })
    ) as typeof fetch;

    await expect(
      requestGithubProjectItemState(
        config,
        {
          issueSubjectId: "issue-1",
          itemId: "item-1",
          request: { type: "state-read" },
        },
        fetchImpl
      )
    ).rejects.toThrow(
      'github_project_state_field_missing: Project item item-1 did not include configured state field "Status". Issue: acme/platform#1.'
    );
  });
});

function graphqlResponse(
  query: string,
  variables: Record<string, string>,
  states: Map<string, string>
): Response {
  if (query.includes("query ExactProjectItemState")) {
    const itemId = variables.itemId;
    const issueId = itemId.replace("item-", "issue-");
    return jsonResponse({
      data: {
        rateLimit: rateLimit(),
        node: {
          __typename: "ProjectV2Item",
          id: itemId,
          project: { id: "project-1" },
          content: {
            id: issueId,
            number: Number(itemId.replace("item-", "")),
            repository: { name: "platform", owner: { login: "acme" } },
          },
          fieldValueByName: statusFieldValue(states.get(itemId) ?? "unknown"),
        },
      },
    });
  }
  if (query.includes("query ProjectFields")) {
    return jsonResponse({
      data: {
        rateLimit: rateLimit(),
        node: {
          __typename: "ProjectV2",
          fields: {
            nodes: [
              {
                __typename: "ProjectV2SingleSelectField",
                id: "status-field",
                name: "Status",
                options: [
                  { id: "in-progress", name: "In progress" },
                  { id: "in-review", name: "In review" },
                ],
              },
            ],
          },
        },
      },
    });
  }
  if (
    query.includes("mutation UpdateProjectItemState") ||
    query.includes("mutation AddIssueComment") ||
    query.includes("mutation UpdateIssueComment")
  ) {
    // GitHub's schema only defines rateLimit on Query; selecting it inside a
    // mutation fails validation in production (see the v0.6.6 transition
    // outage), so the mock enforces the same rule.
    if (query.includes("rateLimit")) {
      return jsonResponse({
        errors: [
          { message: "Field 'rateLimit' doesn't exist on type 'Mutation'" },
        ],
      });
    }
    states.set(variables.itemId, "In review");
    return jsonResponse({
      data: {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: variables.itemId },
        },
      },
    });
  }
  throw new Error(`Unexpected GraphQL operation: ${query.slice(0, 80)}`);
}

function statusFieldValue(name: string) {
  return {
    __typename: "ProjectV2ItemFieldSingleSelectValue",
    name,
    optionId: name.toLowerCase().replaceAll(" ", "-"),
    field: { name: "Status" },
  };
}

function rateLimit() {
  return {
    cost: 1,
    remaining: 4_000,
    resetAt: "2026-07-30T14:00:00.000Z",
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-limit": "5_000",
      "x-ratelimit-remaining": "4_000",
      "x-ratelimit-resource": "graphql",
    },
  });
}

describe("setGithubIssueStateLabel", () => {
  const target = { owner: "acme", name: "app", number: 7 };

  function labelFetch(existing: string[]) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify(existing.map((name) => ({ name }))));
      }
      return new Response(null, {
        status: init?.method === "DELETE" ? 204 : 200,
      });
    });
  }

  function writes(fetchImpl: ReturnType<typeof labelFetch>) {
    return fetchImpl.mock.calls
      .filter(([, init]) => init?.method !== "GET")
      .map(([url, init]) => [
        init?.method,
        String(url),
        init?.body ? JSON.parse(String(init.body)) : undefined,
      ]);
  }

  it("removes stale state labels and adds the new one", async () => {
    const fetchImpl = labelFetch(["bug", "symphony:todo"]);
    await expect(
      setGithubIssueStateLabel(config, target, "In code review", fetchImpl)
    ).resolves.toEqual({ changed: true });
    expect(writes(fetchImpl)).toEqual([
      [
        "DELETE",
        "https://api.github.com/repos/acme/app/issues/7/labels/symphony%3Atodo",
        undefined,
      ],
      [
        "POST",
        "https://api.github.com/repos/acme/app/issues/7/labels",
        { labels: ["symphony:in-code-review"] },
      ],
    ]);
  });

  it("is a no-op when the label is already current", async () => {
    const fetchImpl = labelFetch(["bug", "symphony:in-code-review"]);
    await expect(
      setGithubIssueStateLabel(config, target, "In code review", fetchImpl)
    ).resolves.toEqual({ changed: false });
    expect(writes(fetchImpl)).toEqual([]);
  });
});

describe("mergeGithubPullRequest", () => {
  const input = { pullRequestId: "PR_1", expectedHeadOid: "abc123" };

  function graphqlFetch(autoMergeError?: string) {
    return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (autoMergeError && body.query.includes("enablePullRequestAutoMerge")) {
        return new Response(
          JSON.stringify({ errors: [{ message: autoMergeError }] })
        );
      }
      return new Response(JSON.stringify({ data: {} }));
    });
  }

  function sent(fetchImpl: ReturnType<typeof graphqlFetch>) {
    return fetchImpl.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, string>;
      };
      return {
        mutation: /mutation (\w+)/.exec(body.query)?.[1],
        variables: body.variables,
      };
    });
  }

  it("enables squash auto-merge guarded by expectedHeadOid", async () => {
    const fetchImpl = graphqlFetch();
    await expect(
      mergeGithubPullRequest(config, input, fetchImpl)
    ).resolves.toEqual({ method: "auto_merge" });
    expect(sent(fetchImpl)).toEqual([
      { mutation: "EnablePullRequestAutoMerge", variables: input },
    ]);
  });

  it("merges directly when the pull request is already clean", async () => {
    const fetchImpl = graphqlFetch(
      "Pull request Pull request is in clean status"
    );
    await expect(
      mergeGithubPullRequest(config, input, fetchImpl)
    ).resolves.toEqual({ method: "merge" });
    expect(sent(fetchImpl)).toEqual([
      { mutation: "EnablePullRequestAutoMerge", variables: input },
      { mutation: "MergePullRequest", variables: input },
    ]);
  });

  it("does not fall back on other auto-merge errors", async () => {
    const fetchImpl = graphqlFetch("Head sha didn't match expected head oid");
    await expect(
      mergeGithubPullRequest(config, input, fetchImpl)
    ).rejects.toThrow(/expected head oid/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
