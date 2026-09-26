import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { baseConfig, connect, groupBody, jsonResponse, postCall } from "../helpers.js";

describe("create_beta_group", () => {
  const APP_ID = "6798236186";

  const connectWithWrites = async (fetchImpl: ReturnType<typeof vi.fn>): Promise<Client> =>
    connect({ ...baseConfig, allowWrites: true }, fetchImpl as unknown as typeof fetch);

  it("posts an internal group with the app relationship", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(groupBody({ name: "Internal", isInternalGroup: true })),
    );
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: { appId: APP_ID, name: "Internal", hasAccessToAllBuilds: true },
    });

    expect(result.isError).toBeFalsy();
    const call = postCall(fetchImpl, "/v1/betaGroups");
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body)) as {
      data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> };
    };
    expect(body.data.attributes).toMatchObject({
      name: "Internal",
      isInternalGroup: true,
      hasAccessToAllBuilds: true,
    });
    expect(body.data.relationships).toEqual({
      app: { data: { type: "apps", id: APP_ID } },
    });
  });

  it("omits attributes that were not supplied", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupBody({ name: "Internal" })));
    const client = await connectWithWrites(fetchImpl);

    await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: { appId: APP_ID, name: "Internal" },
    });

    const body = JSON.parse(String(postCall(fetchImpl, "/v1/betaGroups")?.[1]?.body)) as {
      data: { attributes: Record<string, unknown> };
    };
    expect(body.data.attributes).not.toHaveProperty("hasAccessToAllBuilds");
    expect(body.data.attributes).not.toHaveProperty("publicLinkEnabled");
  });

  // The two cross-kind attributes are the easy mistake, and Apple's own error
  // names the field without saying which kind of group it belongs to.
  it("rejects a public link on an internal group before calling Apple", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupBody({ name: "Internal" })));
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: { appId: APP_ID, name: "Internal", publicLinkEnabled: true },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects hasAccessToAllBuilds on an external group before calling Apple", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupBody({ name: "Public" })));
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: {
        appId: APP_ID,
        name: "Public",
        isInternalGroup: false,
        hasAccessToAllBuilds: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
