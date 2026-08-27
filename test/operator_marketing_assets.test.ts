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

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const connect = async (config: Config, fetchImpl?: typeof fetch): Promise<Client> => {
  const { server } = createServer({
    config,
    fetch:
      fetchImpl ??
      (vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch),
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const names = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((tool) => tool.name);

describe("agent-neutral operator tools", () => {
  it("registers operator tools even in read-only mode", async () => {
    const client = await connect(baseConfig);
    const tools = await names(client);
    expect(tools).toContain("app_store_connect_operator_capabilities");
    expect(tools).toContain("app_store_connect_operator_snapshot");
  });

  it("describes the fork as client-agnostic and write-gated", async () => {
    const client = await connect(baseConfig);
    const result = await client.callTool({ name: "app_store_connect_operator_capabilities" });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("clientAgnostic");
    expect(text).toContain("APP_STORE_CONNECT_ALLOW_WRITES=1");
    expect(text).toContain("Custom Product Pages");
  });
});

describe("marketing asset safety", () => {
  it("keeps upload/delete tools hidden until writes are enabled", async () => {
    const readOnly = await names(await connect(baseConfig));
    const writable = await names(await connect({ ...baseConfig, allowWrites: true }));

    expect(readOnly).toContain("app_store_connect_list_custom_page_screenshot_sets");
    expect(readOnly).toContain("app_store_connect_list_app_event_screenshots");
    expect(readOnly).not.toContain("app_store_connect_upload_custom_page_screenshot");
    expect(readOnly).not.toContain("app_store_connect_upload_app_event_image");
    expect(readOnly).not.toContain("app_store_connect_delete_app_event_image");

    expect(writable).toContain("app_store_connect_upload_custom_page_screenshot");
    expect(writable).toContain("app_store_connect_upload_app_event_image");
    expect(writable).toContain("app_store_connect_delete_app_event_image");
  });
});
