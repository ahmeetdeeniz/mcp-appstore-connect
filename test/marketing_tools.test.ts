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

const connect = async (config: Config): Promise<Client> => {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
  const { server } = createServer({
    config,
    fetch: fetchImpl,
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "marketing-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((tool) => tool.name);

describe("marketing and commerce tool registration", () => {
  it("keeps reads visible while writes are disabled", async () => {
    const names = await toolNames(await connect(baseConfig));
    for (const name of [
      "app_store_connect_list_custom_product_pages",
      "app_store_connect_get_custom_product_page",
      "app_store_connect_list_app_events",
      "app_store_connect_get_app_event",
      "app_store_connect_list_promotional_offers",
      "app_store_connect_list_offer_codes",
      "app_store_connect_list_win_back_offers",
    ]) {
      expect(names).toContain(name);
    }

    for (const name of [
      "app_store_connect_create_custom_product_page",
      "app_store_connect_delete_custom_product_page",
      "app_store_connect_create_app_event",
      "app_store_connect_delete_app_event",
      "app_store_connect_create_promotional_offer",
      "app_store_connect_create_offer_code",
      "app_store_connect_create_win_back_offer",
    ]) {
      expect(names).not.toContain(name);
    }
  });

  it("registers write tools only when normal writes are enabled", async () => {
    const names = await toolNames(await connect({ ...baseConfig, allowWrites: true }));
    for (const name of [
      "app_store_connect_create_custom_product_page",
      "app_store_connect_set_custom_product_page_localization",
      "app_store_connect_create_app_event",
      "app_store_connect_update_app_event",
      "app_store_connect_set_app_event_localization",
      "app_store_connect_create_promotional_offer",
      "app_store_connect_add_promotional_offer_price",
      "app_store_connect_create_offer_code",
      "app_store_connect_create_offer_code_custom_code",
      "app_store_connect_create_offer_code_one_time_batch",
      "app_store_connect_create_win_back_offer",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("marks destructive marketing deletes as destructive", async () => {
    const tools = (await (await connect({ ...baseConfig, allowWrites: true })).listTools()).tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "app_store_connect_delete_custom_product_page",
      "app_store_connect_delete_app_event",
      "app_store_connect_delete_promotional_offer",
      "app_store_connect_delete_win_back_offer",
    ]) {
      expect(byName.get(name)?.annotations?.destructiveHint).toBe(true);
    }
  });
});
