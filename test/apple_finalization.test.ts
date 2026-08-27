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
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  const { server } = createServer({ config: { ...config, allowWrites }, fetch: fetchImpl, tokenProvider: staticTokenProvider("jwt-token") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "apple-finalization-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

describe("final Apple operator surface", () => {
  it("keeps reads visible and risky actions write-gated", async () => {
    const read = await connect(false);
    const write = await connect(true);
    const readNames = (await read.listTools()).tools.map((t) => t.name);
    const writeNames = (await write.listTools()).tools.map((t) => t.name);

    for (const name of [
      "app_store_connect_get_age_rating_declaration",
      "app_store_connect_get_build_upload",
      "app_store_connect_wait_for_build_processing",
      "app_store_connect_list_xcode_cloud_products",
      "app_store_connect_list_webhooks",
      "app_store_connect_list_webhook_deliveries",
    ]) {
      expect(readNames).toContain(name);
      expect(writeNames).toContain(name);
    }

    for (const name of [
      "app_store_connect_set_age_rating_declaration",
      "app_store_connect_upload_ipa",
      "app_store_connect_start_xcode_cloud_build",
      "app_store_connect_create_webhook",
      "app_store_connect_update_webhook",
      "app_store_connect_ping_webhook",
      "app_store_connect_delete_webhook",
    ]) {
      expect(readNames).not.toContain(name);
      expect(writeNames).toContain(name);
    }
  });
});
