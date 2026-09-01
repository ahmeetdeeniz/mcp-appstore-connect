import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "../src/client/auth.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const baseConfig: Config = {
  keyId: "ABCD123456",
  issuerId: "69a6de70-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
  allowWrites: true,
  maxRetries: 3,
  tokenTtlSeconds: 1140,
  metadataRoot: "fastlane/metadata",
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const connect = async (fetchImpl: typeof fetch): Promise<Client> => {
  const { server } = createServer({
    config: baseConfig,
    fetch: fetchImpl,
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "testflight-distribution-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

describe("TestFlight distribution workflow", () => {
  it("only attaches groups the build does not already have", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (
        String(url).includes("/v1/builds/build-1/betaGroups") &&
        (init?.method === undefined || init.method === "GET")
      ) {
        return jsonResponse({
          data: [
            { id: "group-existing", type: "betaGroups", attributes: { name: "Internal" } },
          ],
        });
      }
      return jsonResponse({ data: null });
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_distribute_build_to_beta_groups",
      arguments: {
        buildId: "build-1",
        groupIds: ["group-existing", "group-new", "group-new"],
      },
    });

    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result)) as {
      added: string[];
      alreadyPresent: string[];
    };
    expect(body.added).toEqual(["group-new"]);
    expect(body.alreadyPresent).toEqual(["group-existing"]);

    const posts = fetchImpl.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(String(posts[0]?.[0])).toContain("/v1/betaGroups/group-new/relationships/builds");
  });

  it("refuses a duplicate beta review submission before POSTing", async () => {
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, _init?: RequestInit) => {
        if (String(url).includes("/v1/betaAppReviewSubmissions")) {
          return jsonResponse({
            data: [
              {
                id: "review-1",
                type: "betaAppReviewSubmissions",
                attributes: { betaReviewState: "WAITING_FOR_REVIEW" },
              },
            ],
          });
        }
        return jsonResponse({ data: [] });
      },
    );
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_submit_build_for_beta_review",
      arguments: { buildId: "build-1", confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("already has a Beta App Review submission");
    expect(
      fetchImpl.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });
});
