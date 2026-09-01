import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "../src/client/auth.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const config: Config = {
  keyId: "ABCD123456",
  issuerId: "69a6de70-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
  allowWrites: false,
  maxRetries: 3,
  tokenTtlSeconds: 1140,
  metadataRoot: "fastlane/metadata",
};

const connect = async (allowWrites: boolean): Promise<Client> => {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
  const { server } = createServer({
    config: { ...config, allowWrites },
    fetch: fetchImpl,
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "operator-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

describe("PPO, review and workflow registration", () => {
  it("keeps workflow/read tools visible and mutation tools gated", async () => {
    const readClient = await connect(false);
    const writeClient = await connect(true);
    const readNames = (await readClient.listTools()).tools.map((tool) => tool.name);
    const writeNames = (await writeClient.listTools()).tools.map((tool) => tool.name);

    for (const name of [
      "app_store_connect_prepare_release_plan",
      "app_store_connect_review_inbox",
      "app_store_connect_list_product_page_experiments",
      "app_store_connect_get_product_page_experiment",
      "app_store_connect_get_customer_review",
    ]) {
      expect(readNames).toContain(name);
      expect(writeNames).toContain(name);
    }

    for (const name of [
      "app_store_connect_create_product_page_experiment",
      "app_store_connect_create_product_page_treatment",
      "app_store_connect_set_product_page_experiment_running",
      "app_store_connect_respond_to_customer_review",
      "app_store_connect_delete_customer_review_response",
    ]) {
      expect(readNames).not.toContain(name);
      expect(writeNames).toContain(name);
    }
  });
});
