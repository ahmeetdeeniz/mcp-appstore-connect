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
  allowWrites: false,
  maxRetries: 3,
  tokenTtlSeconds: 1140,
  metadataRoot: "fastlane/metadata",
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const connect = async (config: Config, fetchImpl: typeof fetch): Promise<Client> => {
  const { server } = createServer({
    config,
    fetch: fetchImpl,
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "subscription-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

describe("subscription tool registration", () => {
  it("keeps reads visible and writes hidden until writes are enabled", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    const readClient = await connect(baseConfig, fetchImpl);
    const writeClient = await connect({ ...baseConfig, allowWrites: true }, fetchImpl);
    const readNames = (await readClient.listTools()).tools.map((tool) => tool.name);
    const writeNames = (await writeClient.listTools()).tools.map((tool) => tool.name);

    for (const name of [
      "app_store_connect_list_subscription_groups",
      "app_store_connect_list_subscriptions",
      "app_store_connect_get_subscription",
      "app_store_connect_list_subscription_group_localizations",
      "app_store_connect_list_subscription_localizations",
      "app_store_connect_list_subscription_price_points",
      "app_store_connect_get_subscription_availability",
    ]) {
      expect(readNames).toContain(name);
      expect(writeNames).toContain(name);
    }

    for (const name of [
      "app_store_connect_create_subscription_group",
      "app_store_connect_create_subscription",
      "app_store_connect_set_subscription_group_localization",
      "app_store_connect_set_subscription_localization",
      "app_store_connect_set_subscription_availability",
      "app_store_connect_set_subscription_price",
      "app_store_connect_delete_subscription",
      "app_store_connect_delete_subscription_group",
    ]) {
      expect(readNames).not.toContain(name);
      expect(writeNames).toContain(name);
    }
  });
});

describe("subscription writes", () => {
  it("creates a subscription with the group relationship", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({
          data: {
            id: "sub-1",
            type: "subscriptions",
            attributes: { state: "MISSING_METADATA" },
          },
        });
      }
      return jsonResponse({ data: [] });
    });
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    await client.callTool({
      name: "app_store_connect_create_subscription",
      arguments: {
        subscriptionGroupId: "group-1",
        name: "Pro Monthly",
        productId: "com.acme.pro.monthly",
        subscriptionPeriod: "ONE_MONTH",
        groupLevel: 1,
      },
    });

    const post = fetchImpl.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(post).toBeDefined();
    if (!post) throw new Error("Expected a subscription POST request.");
    expect(String(post[0])).toContain("/v1/subscriptions");
    const body = JSON.parse(String((post[1] as RequestInit).body)) as {
      data: { relationships: { group: { data: { id: string } } } };
    };
    expect(body.data.relationships.group.data.id).toBe("group-1");
  });

  it("refuses an over-limit customer-facing subscription name before calling Apple", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_set_subscription_localization",
      arguments: {
        subscriptionId: "sub-1",
        locale: "en-US",
        name: "x".repeat(31),
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("30-character limit");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires availability before creating a subscription price", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/subscriptionAvailability")) {
        return jsonResponse(
          {
            errors: [{ status: "404", title: "not found" }],
          },
          404,
        );
      }
      return jsonResponse({ data: [] });
    });
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_set_subscription_price",
      arguments: {
        subscriptionId: "sub-1",
        baseTerritory: "USA",
        pricePointId: "price-1",
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "Set subscription availability before setting the initial price",
    );
    expect(
      fetchImpl.mock.calls.some(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });
});
