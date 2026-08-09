import { gzipSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

const connect = async (
  config: Config,
  fetchImpl: typeof fetch = vi.fn(async () =>
    jsonResponse({ data: [] }),
  ) as unknown as typeof fetch,
): Promise<Client> => {
  const { server } = createServer({
    config,
    fetch: fetchImpl,
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((t) => t.name).sort();

const callArgs = (fetchImpl: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] =>
  fetchImpl.mock.calls[index] as unknown as [string, RequestInit];

const patchCall = (fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit] | undefined =>
  fetchImpl.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH") as
    | [string, RequestInit]
    | undefined;

const postCall = (
  fetchImpl: ReturnType<typeof vi.fn>,
  path: string,
): [string, RequestInit] | undefined =>
  fetchImpl.mock.calls.find(
    (call) =>
      String(call[0]).includes(path) && (call[1] as RequestInit | undefined)?.method === "POST",
  ) as [string, RequestInit] | undefined;

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

/** A one-segment `/segments` listing, with the attributes the test cares about. */
const segmentsBody = (attributes: Record<string, unknown>): unknown => ({
  data: [{ id: "seg-1", type: "analyticsReportSegments", attributes }],
});

describe("tool registration", () => {
  let readOnly: string[];
  let withWrites: string[];

  beforeAll(async () => {
    readOnly = await toolNames(await connect(baseConfig));
    withWrites = await toolNames(await connect({ ...baseConfig, allowWrites: true }));
  });

  it("registers the read tools in both modes", () => {
    for (const name of [
      "app_store_connect_list_apps",
      "app_store_connect_get_app",
      "app_store_connect_list_versions",
      "app_store_connect_get_version",
      "app_store_connect_list_review_submissions",
      "app_store_connect_list_app_infos",
      "app_store_connect_list_app_info_localizations",
      "app_store_connect_get_app_info_localization",
      "app_store_connect_get_age_rating_declaration",
      "app_store_connect_export_listing",
      "app_store_connect_list_screenshot_sets",
      "app_store_connect_list_screenshots",
      "app_store_connect_get_screenshot",
      "app_store_connect_list_builds",
      "app_store_connect_list_beta_groups",
      "app_store_connect_list_beta_testers",
      "app_store_connect_list_beta_feedback",
      "app_store_connect_download_sales_report",
      "app_store_connect_download_finance_report",
      "app_store_connect_list_analytics_report_requests",
      "app_store_connect_list_analytics_reports",
      "app_store_connect_list_analytics_report_instances",
      "app_store_connect_list_analytics_report_segments",
      "app_store_connect_download_analytics_report_segment",
      "app_store_connect_list_users",
      "app_store_connect_list_bundle_ids",
      "app_store_connect_list_devices",
      "app_store_connect_list_customer_reviews",
      "app_store_connect_list_iap_localizations",
      "app_store_connect_get_iap_review_screenshot",
      "app_store_connect_get_iap_availability",
      "app_store_connect_list_app_categories",
      "app_store_connect_list_app_price_points",
      "app_store_connect_get_app_price_schedule",
      "app_store_connect_get_app_store_review_detail",
    ]) {
      expect(readOnly, name).toContain(name);
      expect(withWrites, name).toContain(name);
    }
  });

  it("hides every write tool when writes are disabled", () => {
    const writeTools = withWrites.filter((name) => !readOnly.includes(name));
    expect(writeTools.length).toBeGreaterThan(6);
    for (const name of [
      "app_store_connect_create_version",
      "app_store_connect_update_version",
      "app_store_connect_update_version_localization",
      "app_store_connect_set_version_build",
      "app_store_connect_release_version",
      "app_store_connect_submit_version_for_review",
      "app_store_connect_cancel_review_submission",
      "app_store_connect_update_app_info_localization",
      "app_store_connect_update_age_rating_declaration",
      "app_store_connect_apply_listing",
      "app_store_connect_upload_screenshot",
      "app_store_connect_delete_screenshot",
      "app_store_connect_delete_screenshot_set",
      "app_store_connect_reorder_screenshots",
      "app_store_connect_create_beta_group",
      "app_store_connect_invite_beta_tester",
      "app_store_connect_remove_tester_from_group",
      "app_store_connect_set_in_app_purchase_price",
      "app_store_connect_update_in_app_purchase",
      "app_store_connect_set_iap_availability",
      "app_store_connect_create_iap_localization",
      "app_store_connect_update_iap_localization",
      "app_store_connect_delete_iap_localization",
      "app_store_connect_upload_iap_review_screenshot",
      "app_store_connect_submit_in_app_purchase_for_review",
      "app_store_connect_create_bundle_id",
      "app_store_connect_enable_capability",
      "app_store_connect_disable_capability",
      "app_store_connect_register_device",
      "app_store_connect_create_analytics_report_request",
      "app_store_connect_update_app",
      "app_store_connect_set_app_categories",
      "app_store_connect_set_app_price",
      "app_store_connect_set_app_store_review_detail",
    ]) {
      expect(readOnly, name).not.toContain(name);
      expect(withWrites, name).toContain(name);
    }
  });

  it("marks read tools readOnly and destructive ones destructive", async () => {
    const client = await connect({ ...baseConfig, allowWrites: true });
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get("app_store_connect_list_apps")?.annotations?.readOnlyHint).toBe(true);
    expect(
      byName.get("app_store_connect_remove_tester_from_group")?.annotations?.destructiveHint,
    ).toBe(true);
    expect(byName.get("app_store_connect_disable_capability")?.annotations?.destructiveHint).toBe(
      true,
    );
    expect(byName.get("app_store_connect_create_version")?.annotations?.destructiveHint).toBe(
      false,
    );
  });
});

describe("read tool calls", () => {
  it("lists apps against /v1/apps with the bundle-id filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_apps",
      arguments: { bundleId: "com.acme.app" },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.origin + url.pathname).toBe("https://api.appstoreconnect.apple.com/v1/apps");
    expect(url.searchParams.get("filter[bundleId]")).toBe("com.acme.app");
  });
});

describe("destructive tools", () => {
  it("refuse to run without an explicit confirm", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_remove_tester_from_group",
      arguments: { groupId: "g1", testerId: "t1" },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("run when confirmed", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_remove_tester_from_group",
      arguments: { groupId: "g1", testerId: "t1", confirm: true },
    });

    expect(result.isError).toBeFalsy();
    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe(
      "https://api.appstoreconnect.apple.com/v1/betaGroups/g1/relationships/betaTesters",
    );
    expect(init.method).toBe("DELETE");
  });
});

const groupBody = (attributes: Record<string, unknown>): unknown => ({
  data: { id: "g-new", type: "betaGroups", attributes },
});

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

describe("get_version", () => {
  const VERSION_ID = "3f3f8952-b1af-4704-8568-353fadf04d10";
  const BUILD_ID = "6befb88e-44c3-4230-a493-6bb43c11a078";

  const body = (attached: boolean): unknown => ({
    data: {
      id: VERSION_ID,
      type: "appStoreVersions",
      attributes: {
        platform: "MAC_OS",
        versionString: "1.3.0",
        appStoreState: "PREPARE_FOR_SUBMISSION",
      },
      relationships: {
        app: { data: { id: "6763524532", type: "apps" } },
        build: attached ? { data: { id: BUILD_ID, type: "builds" } } : { data: null },
      },
    },
    included: attached
      ? [
          {
            id: BUILD_ID,
            type: "builds",
            attributes: {
              version: "155",
              uploadedDate: "2026-08-03T13:46:17-07:00",
              processingState: "VALID",
              expired: false,
            },
          },
        ]
      : [],
  });

  const callTool = async (fetchImpl: ReturnType<typeof vi.fn>): ReturnType<Client["callTool"]> => {
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    return client.callTool({
      name: "app_store_connect_get_version",
      arguments: { versionId: VERSION_ID },
    });
  };

  it("resolves the attached build, which summarizeResponse would have dropped", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(body(true)));

    const result = await callTool(fetchImpl);

    // Without include=build Apple returns no `included`, and the whole point of
    // the tool is lost — assert the request, not just the response.
    expect(callArgs(fetchImpl)[0]).toContain("include=build");
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}")).toEqual({
      id: VERSION_ID,
      platform: "MAC_OS",
      versionString: "1.3.0",
      appStoreState: "PREPARE_FOR_SUBMISSION",
      appId: "6763524532",
      build: {
        id: BUILD_ID,
        version: "155",
        uploadedDate: "2026-08-03T13:46:17-07:00",
        processingState: "VALID",
        expired: false,
      },
    });
  });

  it("reports a version with no build attached as null rather than omitting it", async () => {
    const result = await callTool(vi.fn(async () => jsonResponse(body(false))));

    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}").build).toBeNull();
  });

  it("still returns the build id when Apple sideloads no build resource", async () => {
    const withoutInclude = body(true) as { included: unknown[] };
    withoutInclude.included = [];

    const result = await callTool(vi.fn(async () => jsonResponse(withoutInclude)));

    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}").build).toEqual({
      id: BUILD_ID,
    });
  });
});

describe("set_version_build", () => {
  const VERSION_ID = "01f7fc5e-fef8-49ec-b749-7849cdde3e51";
  const BUILD_ID = "0c15a960-b73d-4893-8788-cfbab4ca072b";

  const versionBody = (overrides: Record<string, unknown> = {}): unknown => ({
    data: {
      id: VERSION_ID,
      type: "appStoreVersions",
      attributes: {
        platform: "MAC_OS",
        versionString: "1.8.0",
        appStoreState: "PREPARE_FOR_SUBMISSION",
        ...overrides,
      },
      relationships: { app: { data: { id: "6753819990", type: "apps" } } },
    },
  });

  // `builds.attributes.version` is the build number (192); the marketing
  // version only arrives via the included preReleaseVersion.
  const buildBody = (
    overrides: Record<string, unknown> = {},
    preRelease: Record<string, unknown> = {},
    appId = "6753819990",
  ): unknown => ({
    data: {
      id: BUILD_ID,
      type: "builds",
      attributes: { version: "192", processingState: "VALID", expired: false, ...overrides },
      relationships: { app: { data: { id: appId, type: "apps" } } },
    },
    included: [
      {
        id: "pre-1",
        type: "preReleaseVersions",
        attributes: { version: "1.8.0", platform: "MAC_OS", ...preRelease },
      },
    ],
  });

  /** Route by URL: the happy path is two preflight GETs then the PATCH. */
  const routed = (version: unknown, build: unknown): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      if (url.includes("/v1/builds/")) return jsonResponse(build);
      if (url.includes("/appStoreVersions/")) return jsonResponse(version);
      return jsonResponse({ data: {} });
    });

  const callTool = async (
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name: "app_store_connect_set_version_build", arguments: args });
  };

  it("attaches a build with the build relationship", async () => {
    const fetchImpl = routed(versionBody(), buildBody());

    const result = await callTool({ versionId: VERSION_ID, buildId: BUILD_ID }, fetchImpl);

    expect(result.isError).toBeFalsy();
    const patch = patchCall(fetchImpl);
    expect(patch?.[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${VERSION_ID}`,
    );
    expect(JSON.parse(String(patch?.[1].body))).toEqual({
      data: {
        id: VERSION_ID,
        type: "appStoreVersions",
        relationships: { build: { data: { id: BUILD_ID, type: "builds" } } },
      },
    });
  });

  it("sideloads the preReleaseVersion when preflighting the build", async () => {
    const fetchImpl = routed(versionBody(), buildBody());

    await callTool({ versionId: VERSION_ID, buildId: BUILD_ID }, fetchImpl);

    const buildCall = fetchImpl.mock.calls.find((call) => String(call[0]).includes("/v1/builds/"));
    expect(new URL(String(buildCall?.[0])).searchParams.get("include")).toBe("preReleaseVersion");
  });

  it("detaches with a null relationship and never reads a build", async () => {
    const fetchImpl = routed(versionBody(), buildBody());

    const result = await callTool({ versionId: VERSION_ID, detach: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(patchCall(fetchImpl)?.[1].body)).data.relationships.build).toEqual({
      data: null,
    });
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/v1/builds/"))).toBe(
      false,
    );
  });

  it.each([
    [
      "a version past PREPARE_FOR_SUBMISSION",
      versionBody({ appStoreState: "READY_FOR_SALE" }),
      buildBody(),
      "READY_FOR_SALE",
    ],
    [
      "a still-processing build",
      versionBody(),
      buildBody({ processingState: "PROCESSING" }),
      "PROCESSING",
    ],
    ["an invalid build", versionBody(), buildBody({ processingState: "INVALID" }), "INVALID"],
    ["an expired build", versionBody(), buildBody({ expired: true }), "expired"],
    ["a build from another app", versionBody(), buildBody({}, {}, "9999999999"), "belongs to app"],
    ["a mismatched version string", versionBody(), buildBody({}, { version: "1.7.1" }), "1.7.1"],
    ["a mismatched platform", versionBody(), buildBody({}, { platform: "IOS" }), "IOS"],
  ])("refuses %s without issuing a PATCH", async (_label, version, build, expected) => {
    const fetchImpl = routed(version, build);

    const result = await callTool({ versionId: VERSION_ID, buildId: BUILD_ID }, fetchImpl);

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(expected);
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  it("reports every failing precondition at once", async () => {
    const fetchImpl = routed(
      versionBody({ appStoreState: "READY_FOR_SALE" }),
      buildBody({ processingState: "PROCESSING", expired: true }),
    );

    const result = await callTool({ versionId: VERSION_ID, buildId: BUILD_ID }, fetchImpl);

    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("READY_FOR_SALE");
    expect(text).toContain("PROCESSING");
    expect(text).toContain("expired");
  });

  it.each([
    ["both buildId and detach", { versionId: VERSION_ID, buildId: BUILD_ID, detach: true }],
    ["neither buildId nor detach", { versionId: VERSION_ID }],
  ])("rejects %s before any request", async (_label, args) => {
    const fetchImpl = routed(versionBody(), buildBody());

    const result = await callTool(args, fetchImpl);

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("age rating declaration", () => {
  const APP_INFO_ID = "63998931-e8e1-440e-b295-e2f37df48917";
  const DECLARATION_ID = "a1b2c3d4-0000-4000-8000-000000000001";

  const routed = (): ReturnType<typeof vi.fn> =>
    vi.fn(async () =>
      jsonResponse({
        data: {
          id: DECLARATION_ID,
          type: "ageRatingDeclarations",
          attributes: { socialMedia: null, userGeneratedContent: false },
        },
      }),
    );

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  it("reads the declaration through appInfos, not appStoreVersions", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_get_age_rating_declaration",
      { appInfoId: APP_INFO_ID },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(callArgs(fetchImpl)[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/appInfos/${APP_INFO_ID}/ageRatingDeclaration`,
    );
    // The id the update tool takes has to survive the summarizer.
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(DECLARATION_ID);
  });

  it("patches only the answers it was given", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_update_age_rating_declaration",
      { declarationId: DECLARATION_ID, socialMedia: false },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const patch = patchCall(fetchImpl);
    expect(patch?.[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/ageRatingDeclarations/${DECLARATION_ID}`,
    );
    expect(JSON.parse(String(patch?.[1].body))).toEqual({
      data: {
        id: DECLARATION_ID,
        type: "ageRatingDeclarations",
        attributes: { socialMedia: false },
      },
    });
  });

  it("sends a null kidsAgeBand rather than dropping it", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_update_age_rating_declaration",
      { declarationId: DECLARATION_ID, kidsAgeBand: null },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(patchCall(fetchImpl)?.[1].body)).data.attributes).toEqual({
      kidsAgeBand: null,
    });
  });
});

describe("update_version", () => {
  const VERSION_ID = "01f7fc5e-fef8-49ec-b749-7849cdde3e51";
  const APP_ID = "6753819990";

  const routed = (appStoreState = "PREPARE_FOR_SUBMISSION"): ReturnType<typeof vi.fn> =>
    vi.fn(async () =>
      jsonResponse({
        data: {
          id: VERSION_ID,
          type: "appStoreVersions",
          attributes: { platform: "MAC_OS", versionString: "1.8.0", appStoreState },
        },
      }),
    );

  const callTool = async (
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
    name = "app_store_connect_update_version",
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  it("patches only releaseType and never touches relationships", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID, releaseType: "MANUAL" }, fetchImpl);

    expect(result.isError).toBeFalsy();
    const patch = patchCall(fetchImpl);
    expect(patch?.[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${VERSION_ID}`,
    );
    expect(JSON.parse(String(patch?.[1].body))).toEqual({
      data: {
        id: VERSION_ID,
        type: "appStoreVersions",
        attributes: { releaseType: "MANUAL" },
      },
    });
  });

  it("sends both attributes for a scheduled release", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      {
        versionId: VERSION_ID,
        releaseType: "SCHEDULED",
        earliestReleaseDate: "2026-08-01T12:00:00-07:00",
      },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(patchCall(fetchImpl)?.[1].body)).data.attributes).toEqual({
      releaseType: "SCHEDULED",
      earliestReleaseDate: "2026-08-01T12:00:00-07:00",
    });
  });

  it.each([
    ["SCHEDULED without a date", { versionId: VERSION_ID, releaseType: "SCHEDULED" }],
    [
      "a date on a manual release",
      {
        versionId: VERSION_ID,
        releaseType: "MANUAL",
        earliestReleaseDate: "2026-08-01T12:00:00-07:00",
      },
    ],
    ["no updatable field", { versionId: VERSION_ID }],
  ])("rejects %s before any request", async (_label, args) => {
    const fetchImpl = routed();

    const result = await callTool(args, fetchImpl);

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a version past PREPARE_FOR_SUBMISSION without issuing a PATCH", async () => {
    const fetchImpl = routed("READY_FOR_SALE");

    const result = await callTool({ versionId: VERSION_ID, releaseType: "MANUAL" }, fetchImpl);

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("READY_FOR_SALE");
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  it("creates a version already set to manual release", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      { appId: APP_ID, versionString: "1.9.0", platform: "MAC_OS", releaseType: "MANUAL" },
      fetchImpl,
      "app_store_connect_create_version",
    );

    expect(result.isError).toBeFalsy();
    const post = postCall(fetchImpl, "/v1/appStoreVersions");
    expect(JSON.parse(String(post?.[1].body)).data.attributes).toEqual({
      platform: "MAC_OS",
      versionString: "1.9.0",
      releaseType: "MANUAL",
    });
  });
});

describe("in-app purchase pricing", () => {
  const IAP_ID = "6f4d2c1a-0000-4000-8000-000000000001";
  const PRICE_POINT_ID = "eyJzIjoiNjc0NCIsInQiOiJVU0EiLCJwIjoiMTAwMDgifQ";

  const pricePointsBody = (): unknown => ({
    data: [
      {
        id: PRICE_POINT_ID,
        type: "inAppPurchasePricePoints",
        attributes: { customerPrice: "4.99", proceeds: "3.49" },
      },
      {
        id: "other-point",
        type: "inAppPurchasePricePoints",
        attributes: { customerPrice: "9.99", proceeds: "6.99" },
      },
    ],
  });

  /** Price-point lookups are the preflight; the POST is the schedule create. */
  const routed = (points: unknown = pricePointsBody()): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      if (String(url).includes("/pricePoints")) return jsonResponse(points);
      return jsonResponse({ data: { id: "sched-1", type: "inAppPurchasePriceSchedules" } });
    });

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  it("builds the inline-create schedule and echoes the price it set", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_set_in_app_purchase_price",
      {
        inAppPurchaseId: IAP_ID,
        pricePointId: PRICE_POINT_ID,
        baseTerritory: "USA",
        confirm: true,
      },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const post = postCall(fetchImpl, "/v1/inAppPurchasePriceSchedules");
    const body = JSON.parse(String(post?.[1].body));

    // The placeholder in manualPrices must match the included price's id, or
    // Apple resolves the relationship to nothing.
    const placeholder = body.data.relationships.manualPrices.data[0].id;
    expect(body.included[0].id).toBe(placeholder);
    expect(body.data.relationships.inAppPurchase.data).toEqual({
      type: "inAppPurchases",
      id: IAP_ID,
    });
    expect(body.data.relationships.baseTerritory.data).toEqual({
      type: "territories",
      id: "USA",
    });
    expect(body.included[0].relationships.inAppPurchasePricePoint.data).toEqual({
      type: "inAppPurchasePricePoints",
      id: PRICE_POINT_ID,
    });
    // startDate omitted means "now" — it must not be sent as null.
    expect(body.included[0].attributes).toEqual({});

    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text).priced).toEqual({
      pricePointId: PRICE_POINT_ID,
      baseTerritory: "USA",
      customerPrice: "4.99",
      proceeds: "3.49",
      startDate: "immediate",
    });
  });

  it("passes start and end dates through as attributes", async () => {
    const fetchImpl = routed();

    await callTool(
      "app_store_connect_set_in_app_purchase_price",
      {
        inAppPurchaseId: IAP_ID,
        pricePointId: PRICE_POINT_ID,
        baseTerritory: "USA",
        startDate: "2026-09-01",
        endDate: "2026-12-31",
        confirm: true,
      },
      fetchImpl,
    );

    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/inAppPurchasePriceSchedules")?.[1].body),
    );
    expect(body.included[0].attributes).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-12-31",
    });
  });

  it("refuses a price point from another territory without pricing anything", async () => {
    // The IAP's USA catalogue simply does not contain the requested id.
    const fetchImpl = routed({ data: [] });

    const result = await callTool(
      "app_store_connect_set_in_app_purchase_price",
      {
        inAppPurchaseId: IAP_ID,
        pricePointId: PRICE_POINT_ID,
        baseTerritory: "USA",
        confirm: true,
      },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(PRICE_POINT_ID);
    expect(postCall(fetchImpl, "/v1/inAppPurchasePriceSchedules")).toBeUndefined();
  });

  it("requires confirm before changing a price", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_set_in_app_purchase_price",
      { inAppPurchaseId: IAP_ID, pricePointId: PRICE_POINT_ID, baseTerritory: "USA" },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("filters price points by territory", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_list_iap_price_points",
      { inAppPurchaseId: IAP_ID, territory: "FRA" },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const url = new URL(String(callArgs(fetchImpl)[0]));
    expect(url.pathname).toBe(`/v2/inAppPurchases/${IAP_ID}/pricePoints`);
    expect(url.searchParams.get("filter[territory]")).toBe("FRA");
  });

  it("flattens the price schedule's sideloaded prices", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          id: "sched-1",
          type: "inAppPurchasePriceSchedules",
          relationships: { baseTerritory: { data: { id: "USA", type: "territories" } } },
        },
        included: [
          {
            id: "price-1",
            type: "inAppPurchasePrices",
            attributes: { startDate: "2026-09-01", endDate: null, manual: true },
            relationships: {
              territory: { data: { id: "USA", type: "territories" } },
              inAppPurchasePricePoint: {
                data: { id: PRICE_POINT_ID, type: "inAppPurchasePricePoints" },
              },
            },
          },
          { id: "USA", type: "territories", attributes: { currency: "USD" } },
        ],
      }),
    );

    const result = await callTool(
      "app_store_connect_get_iap_price_schedule",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}")).toEqual({
      scheduleId: "sched-1",
      baseTerritory: "USA",
      manualPrices: [
        {
          id: "price-1",
          startDate: "2026-09-01",
          endDate: null,
          manual: true,
          territory: "USA",
          pricePointId: PRICE_POINT_ID,
        },
      ],
    });
  });

  it("reports an unpriced IAP as an empty price list", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { id: "sched-1", type: "inAppPurchasePriceSchedules" } }),
    );

    const result = await callTool(
      "app_store_connect_get_iap_price_schedule",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(
      JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}").manualPrices,
    ).toEqual([]);
  });
});

describe("submit_version_for_review", () => {
  const VERSION_ID = "01f7fc5e-fef8-49ec-b749-7849cdde3e51";
  const APP_ID = "6753819990";
  const SUBMISSION_ID = "sub-1";

  /**
   * Shaped like Apple's actual answer: `build` is always in `relationships`, but
   * the `app` key is absent entirely unless the request asked for it via
   * `include`. A fixture that handed back `app` unconditionally is what let the
   * first cut of this tool ship broken.
   */
  const versionBody = (
    attrs: Record<string, unknown> = {},
    relationships: Record<string, unknown> = {},
    withApp = false,
  ): unknown => ({
    data: {
      id: VERSION_ID,
      type: "appStoreVersions",
      attributes: {
        platform: "MAC_OS",
        versionString: "1.8.0",
        appStoreState: "PREPARE_FOR_SUBMISSION",
        ...attrs,
      },
      relationships: {
        build: { data: { id: "build-1", type: "builds" } },
        ...(withApp ? { app: { data: { id: APP_ID, type: "apps" } } } : {}),
        ...relationships,
      },
    },
  });

  const submission = (state: string): unknown => ({
    id: SUBMISSION_ID,
    type: "reviewSubmissions",
    attributes: { platform: "MAC_OS", state },
  });

  type Routes = {
    /** Receives whether the request asked to include the app relationship. */
    version?: (withApp: boolean) => unknown;
    /** Submissions already with Apple, keyed off the in-flight filter. */
    inFlight?: unknown[];
    /** Not-yet-submitted drafts to reuse. */
    drafts?: unknown[];
    items?: unknown[];
  };

  /** Route by URL, method and `filter[state]` — the two list GETs share a path. */
  const routed = (routes: Routes = {}): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      const state = parsed.searchParams.get("filter[state]") ?? "";

      if (parsed.pathname.includes("/reviewSubmissions") && parsed.pathname.includes("/items")) {
        return jsonResponse({ data: routes.items ?? [] });
      }
      if (parsed.pathname.endsWith("/reviewSubmissions") && method === "GET") {
        const drafts = state === "READY_FOR_REVIEW";
        return jsonResponse({ data: (drafts ? routes.drafts : routes.inFlight) ?? [] });
      }
      if (parsed.pathname.endsWith("/reviewSubmissions") && method === "POST") {
        return jsonResponse({ data: submission("READY_FOR_REVIEW") });
      }
      if (parsed.pathname.includes("/appStoreVersions/")) {
        const withApp = (parsed.searchParams.get("include") ?? "").split(",").includes("app");
        return jsonResponse(routes.version?.(withApp) ?? versionBody({}, {}, withApp));
      }
      return jsonResponse({ data: submission("WAITING_FOR_REVIEW") });
    });

  const callTool = async (
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({
      name: "app_store_connect_submit_version_for_review",
      arguments: args,
    });
  };

  it("creates a submission, adds the version and submits it", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();

    const created = postCall(fetchImpl, "/v1/reviewSubmissions") as [string, RequestInit];
    expect(JSON.parse(String(created[1].body))).toEqual({
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "MAC_OS" },
        relationships: { app: { data: { type: "apps", id: APP_ID } } },
      },
    });

    const item = postCall(fetchImpl, "/v1/reviewSubmissionItems") as [string, RequestInit];
    expect(JSON.parse(String(item[1].body)).data.relationships).toEqual({
      reviewSubmission: { data: { type: "reviewSubmissions", id: SUBMISSION_ID } },
      appStoreVersion: { data: { type: "appStoreVersions", id: VERSION_ID } },
    });

    const patch = patchCall(fetchImpl);
    expect(patch?.[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/reviewSubmissions/${SUBMISSION_ID}`,
    );
    expect(JSON.parse(String(patch?.[1].body)).data.attributes).toEqual({ submitted: true });
  });

  it("reuses an existing draft rather than creating a second one", async () => {
    const fetchImpl = routed({ drafts: [submission("READY_FOR_REVIEW")] });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(postCall(fetchImpl, "/v1/reviewSubmissions")).toBeUndefined();
    expect(postCall(fetchImpl, "/v1/reviewSubmissionItems")).toBeDefined();
  });

  it("skips the item when the draft already holds this version", async () => {
    const fetchImpl = routed({
      drafts: [submission("READY_FOR_REVIEW")],
      items: [
        {
          id: "item-1",
          type: "reviewSubmissionItems",
          relationships: {
            appStoreVersion: { data: { id: VERSION_ID, type: "appStoreVersions" } },
          },
        },
      ],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(postCall(fetchImpl, "/v1/reviewSubmissionItems")).toBeUndefined();
    expect(patchCall(fetchImpl)).toBeDefined();
  });

  it("refuses without an explicit confirm", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Apple omits the `app` relationship unless asked, so deriving the app id from
  // a bare GET fails on every real version. Assert the include, not just that the
  // happy path works against a lenient fixture.
  it("asks Apple to include the app relationship", async () => {
    const fetchImpl = routed();

    await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    const versionCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).includes("/v1/appStoreVersions/"),
    );
    const include = new URL(String(versionCall?.[0])).searchParams.get("include") ?? "";
    expect(include.split(",")).toContain("app");
  });

  it("names the app relationship, not the platform, when the app id is missing", async () => {
    // Force the pre-fix shape: a response that never carries `app`.
    const fetchImpl = routed({ version: () => versionBody({}, {}, false) });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("app relationship");
    expect(text).not.toContain("carries no platform");
  });

  it.each([
    [
      "a version with no build attached",
      { version: (withApp: boolean) => versionBody({}, { build: { data: null } }, withApp) },
      "no build is attached",
    ],
    [
      "a version already past submission",
      {
        version: (withApp: boolean) =>
          versionBody({ appStoreState: "READY_FOR_SALE" }, {}, withApp),
      },
      "READY_FOR_SALE",
    ],
    [
      "an app whose submission is already with Apple",
      { inFlight: [submission("IN_REVIEW")] },
      "IN_REVIEW",
    ],
  ])("refuses %s without submitting", async (_label, routes, expected) => {
    const fetchImpl = routed(routes);

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(expected);
    expect(patchCall(fetchImpl)).toBeUndefined();
    expect(postCall(fetchImpl, "/v1/reviewSubmissionItems")).toBeUndefined();
  });
});

describe("release_version", () => {
  const VERSION_ID = "01f7fc5e-fef8-49ec-b749-7849cdde3e51";

  const routed = (appStoreState = "PENDING_DEVELOPER_RELEASE"): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonResponse({ data: { id: "rel-1", type: "appStoreVersionReleaseRequests" } });
      }
      return jsonResponse({
        data: {
          id: VERSION_ID,
          type: "appStoreVersions",
          attributes: { versionString: "1.8.0", appStoreState },
        },
      });
    });

  const callTool = async (
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name: "app_store_connect_release_version", arguments: args });
  };

  it("posts a release request for a version pending developer release", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    const posted = postCall(fetchImpl, "/v1/appStoreVersionReleaseRequests") as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(posted[1].body))).toEqual({
      data: {
        type: "appStoreVersionReleaseRequests",
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: VERSION_ID } },
        },
      },
    });
  });

  it("refuses without an explicit confirm", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["READY_FOR_SALE", "already READY_FOR_SALE"],
    ["PENDING_APPLE_RELEASE", "nothing to release by hand"],
    ["WAITING_FOR_REVIEW", "only a version Apple has approved"],
  ])("refuses a %s version without posting", async (state, expected) => {
    const fetchImpl = routed(state);

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(expected);
    expect(postCall(fetchImpl, "/v1/appStoreVersionReleaseRequests")).toBeUndefined();
  });
});

describe("customer reviews", () => {
  const APP_ID = "1234567890";

  it("lists newest-first and comma-joins the rating filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID, rating: [1, 2], territory: "FRA" },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/apps/${APP_ID}/customerReviews`);
    // JSON:API takes a comma-joined list here, not repeated keys.
    expect(url.searchParams.get("filter[rating]")).toBe("1,2");
    expect(url.searchParams.get("filter[territory]")).toBe("FRA");
    expect(url.searchParams.get("sort")).toBe("-createdDate");
  });

  it("omits the answered filter entirely when it is not asked for", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.searchParams.has("exists[publishedResponse]")).toBe(false);
    expect(url.searchParams.has("filter[rating]")).toBe(false);
  });

  it("passes answered:false through as the unanswered filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID, answered: false },
    });

    // `compact` drops undefined, not false — a `false` here is a real filter.
    expect(new URL(callArgs(fetchImpl)[0]).searchParams.get("exists[publishedResponse]")).toBe(
      "false",
    );
  });
});

describe("reports require a vendor number", () => {
  it("fails clearly when neither config nor argument supplies one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_download_sales_report",
      arguments: { reportDate: "2026-06" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("vendor number");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("analytics reports", () => {
  const APP_ID = "1234567890";
  const REQUEST_ID = "req-0000-4000-8000-000000000001";
  const REPORT_ID = "rep-0000-4000-8000-000000000002";
  const INSTANCE_ID = "ins-0000-4000-8000-000000000003";
  const SEGMENT_URL = "https://api-reports.itunes.apple.com/segments/abc?token=xyz";

  const CSV = "Date\tTerritory\tInstallations\n2026-06-01\tUS\t1204\n2026-06-01\tFR\t311\n";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    return client.callTool({ name, arguments: args });
  };

  it("lists an app's existing report requests so a duplicate is not created", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    await callTool(
      "app_store_connect_list_analytics_report_requests",
      { appId: APP_ID, accessType: "ONGOING" },
      fetchImpl,
    );

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/apps/${APP_ID}/analyticsReportRequests`);
    expect(url.searchParams.get("filter[accessType]")).toBe("ONGOING");
  });

  it("lists reports for a request with the category filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    await callTool(
      "app_store_connect_list_analytics_reports",
      { reportRequestId: REQUEST_ID, category: "APP_STORE_ENGAGEMENT" },
      fetchImpl,
    );

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/analyticsReportRequests/${REQUEST_ID}/reports`);
    expect(url.searchParams.get("filter[category]")).toBe("APP_STORE_ENGAGEMENT");
  });

  it("lists instances for a report with the granularity filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    await callTool(
      "app_store_connect_list_analytics_report_instances",
      { reportId: REPORT_ID, granularity: "DAILY" },
      fetchImpl,
    );

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/analyticsReports/${REPORT_ID}/instances`);
    expect(url.searchParams.get("filter[granularity]")).toBe("DAILY");
  });

  it("lists segments for an instance", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    await callTool(
      "app_store_connect_list_analytics_report_segments",
      { instanceId: INSTANCE_ID },
      fetchImpl,
    );

    expect(new URL(callArgs(fetchImpl)[0]).pathname).toBe(
      `/v1/analyticsReportInstances/${INSTANCE_ID}/segments`,
    );
  });

  /**
   * The point of the whole chain: the segment's `url` is the only place the
   * numbers live, and it is a short-lived signed URL off the API host, so the
   * tool resolves it itself rather than making the caller carry it between calls.
   */
  it("resolves the segment and returns the decompressed rows", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).startsWith("https://api-reports.")
        ? new Response(gzipSync(Buffer.from(CSV)), { status: 200 })
        : jsonResponse(segmentsBody({ url: SEGMENT_URL, sizeInBytes: 512, checksum: "deadbeef" })),
    );

    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID },
      fetchImpl as ReturnType<typeof vi.fn>,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result));
    expect(body.segment).toEqual({ index: 0, of: 1, checksum: "deadbeef", sizeInBytes: 512 });
    expect(body.report).toBe(CSV);
    expect(body.truncated).toBe(false);
    expect(callArgs(fetchImpl as ReturnType<typeof vi.fn>, 1)[0]).toBe(SEGMENT_URL);
  });

  it("truncates a long segment to maxLines", async () => {
    const long = `${Array.from({ length: 40 }, (_, i) => `2026-06-01\tUS\t${i}`).join("\n")}\n`;
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).startsWith("https://api-reports.")
        ? new Response(gzipSync(Buffer.from(long)), { status: 200 })
        : jsonResponse(segmentsBody({ url: SEGMENT_URL, sizeInBytes: 512 })),
    );

    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID, maxLines: 5 },
      fetchImpl as ReturnType<typeof vi.fn>,
    );

    const body = JSON.parse(textOf(result));
    expect(body.truncated).toBe(true);
    expect(body.report.split("\n")).toHaveLength(5);
  });

  it("refuses an oversized segment before downloading it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(segmentsBody({ url: SEGMENT_URL, sizeInBytes: 900_000_000 })),
    );

    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Raise maxBytes");
    // Only the segments listing went out — the blob was never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("says an instance has no data rather than returning an empty report", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no segments");
  });

  it("reports how many segments exist when the index is out of range", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(segmentsBody({ url: SEGMENT_URL, sizeInBytes: 512 })),
    );

    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID, segmentIndex: 3 },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("this instance has 1");
  });
});

describe("in-app purchase metadata", () => {
  const IAP_ID = "6f4d2c1a-0000-4000-8000-000000000001";
  const LOC_ID = "1a2b3c4d-0000-4000-8000-000000000002";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  const okFetch = (body: unknown = { data: { id: LOC_ID, type: "inAppPurchaseLocalizations" } }) =>
    vi.fn(async () => jsonResponse(body));

  it("patches familySharable onto the v2 resource", async () => {
    const fetchImpl = okFetch({ data: { id: IAP_ID, type: "inAppPurchases" } });

    const result = await callTool(
      "app_store_connect_update_in_app_purchase",
      { inAppPurchaseId: IAP_ID, familySharable: true, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const patch = patchCall(fetchImpl);
    expect(new URL(String(patch?.[0])).pathname).toBe(`/v2/inAppPurchases/${IAP_ID}`);
    const body = JSON.parse(String(patch?.[1].body));
    expect(body.data.type).toBe("inAppPurchases");
    expect(body.data.attributes).toEqual({ familySharable: true });
    // `confirm` is a gate, not an attribute — sending it would 409.
    expect(body.data.attributes.confirm).toBeUndefined();
  });

  it("creates a localization through the inAppPurchaseV2 relationship", async () => {
    const fetchImpl = okFetch();

    const result = await callTool(
      "app_store_connect_create_iap_localization",
      {
        inAppPurchaseId: IAP_ID,
        locale: "en-US",
        name: "Cadence Pro",
        description: "Every engine, batch queue and export.",
        confirm: true,
      },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/inAppPurchaseLocalizations")?.[1].body),
    );
    expect(body.data.type).toBe("inAppPurchaseLocalizations");
    expect(body.data.attributes).toEqual({
      name: "Cadence Pro",
      locale: "en-US",
      description: "Every engine, batch queue and export.",
    });
    // The relationship key is `inAppPurchaseV2`; `inAppPurchase` is rejected.
    expect(body.data.relationships.inAppPurchaseV2.data).toEqual({
      type: "inAppPurchases",
      id: IAP_ID,
    });
  });

  it("refuses an over-length name before calling Apple", async () => {
    const fetchImpl = okFetch();

    const result = await callTool(
      "app_store_connect_create_iap_localization",
      { inAppPurchaseId: IAP_ID, locale: "en-US", name: "x".repeat(31), confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("30-character");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an over-length description before calling Apple", async () => {
    const fetchImpl = okFetch();

    const result = await callTool(
      "app_store_connect_update_iap_localization",
      { localizationId: LOC_ID, description: "y".repeat(46), confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("45-character");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to submit an IAP that is still MISSING_METADATA", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { id: IAP_ID, type: "inAppPurchases", attributes: { state: "MISSING_METADATA" } },
      }),
    );

    const result = await callTool(
      "app_store_connect_submit_in_app_purchase_for_review",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("MISSING_METADATA");
    expect(postCall(fetchImpl, "/v1/inAppPurchaseSubmissions")).toBeUndefined();
  });

  it("submits an IAP that is READY_TO_SUBMIT", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ data: { id: "sub-1", type: "inAppPurchaseSubmissions" } });
      }
      return jsonResponse({
        data: { id: IAP_ID, type: "inAppPurchases", attributes: { state: "READY_TO_SUBMIT" } },
      });
    });

    const result = await callTool(
      "app_store_connect_submit_in_app_purchase_for_review",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(String(postCall(fetchImpl, "/v1/inAppPurchaseSubmissions")?.[1].body));
    expect(body.data.relationships.inAppPurchaseV2.data.id).toBe(IAP_ID);
  });
});

describe("in-app purchase availability", () => {
  const IAP_ID = "6f4d2c1a-0000-4000-8000-000000000001";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  it("reports data:null when availability has never been set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: null }));

    const result = await callTool(
      "app_store_connect_get_iap_availability",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain('"data": null');
  });

  it("resolves every territory when none are named", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ data: { id: "avail-1", type: "inAppPurchaseAvailabilities" } });
      }
      return jsonResponse({
        data: [
          { id: "USA", type: "territories" },
          { id: "FRA", type: "territories" },
        ],
      });
    });

    const result = await callTool(
      "app_store_connect_set_iap_availability",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/inAppPurchaseAvailabilities")?.[1].body),
    );
    // This endpoint uses `inAppPurchase`, unlike the localization and submission
    // endpoints which use `inAppPurchaseV2`.
    expect(body.data.relationships.inAppPurchase.data).toEqual({
      type: "inAppPurchases",
      id: IAP_ID,
    });
    expect(body.data.relationships.availableTerritories.data).toEqual([
      { type: "territories", id: "USA" },
      { type: "territories", id: "FRA" },
    ]);
    expect(body.data.attributes.availableInNewTerritories).toBe(true);
  });

  it("reads a never-set availability 404 as 'not set', not an error", async () => {
    // Apple 404s a to-one sub-resource that was never created, and names the
    // PARENT's id in the message — raw, that reads as a broken request.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [
              {
                status: "404",
                code: "NOT_FOUND",
                detail:
                  "There is no resource of type 'inAppPurchaseAvailabilities' with id '" +
                  IAP_ID +
                  "'",
              },
            ],
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await callTool(
      "app_store_connect_get_iap_availability",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("never been set");
  });

  it("refuses to make an IAP available nowhere", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    const result = await callTool(
      "app_store_connect_set_iap_availability",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("available nowhere");
    expect(postCall(fetchImpl, "/v1/inAppPurchaseAvailabilities")).toBeUndefined();
  });
});

// The five gates a first submission trips over live on the app and the appInfo,
// not on the version — so nothing in the version's own state hints at them, and
// Apple reports each one against a resource path with no id to chase.
const notFound = (): Response =>
  new Response(JSON.stringify({ errors: [{ status: "404", code: "NOT_FOUND" }] }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

const bodyOf = (init: RequestInit | undefined): Record<string, unknown> =>
  JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

describe("submission prerequisites", () => {
  const APP_ID = "6798236186";
  const VERSION_ID = "437e7c81-a74a-4aca-ab17-c26bad76fc67";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  describe("set_app_store_review_detail", () => {
    // PATCH against a version with no detail 404s and POST against one that has
    // it 409s, so picking the verb is a property of server state. Getting this
    // wrong is the whole reason the tool exists rather than two thinner ones.
    it("creates the detail when the version has none", async () => {
      // Matched on method, not path: the lookup GET ends in
      // `/appStoreReviewDetail` and the create POST goes to
      // `/appStoreReviewDetails`, so a substring match on the former also
      // swallows the latter and the create 404s too.
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? notFound()
          : jsonResponse({ data: { id: "rd-1", type: "appStoreReviewDetails" } }),
      );

      const result = await callTool(
        "app_store_connect_set_app_store_review_detail",
        { versionId: VERSION_ID, contactEmail: "dev@example.com", demoAccountRequired: false },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('"created": true');

      const post = postCall(fetchImpl, "/v1/appStoreReviewDetails");
      expect(post).toBeDefined();
      const data = bodyOf(post?.[1]).data as Record<string, unknown>;
      expect((data.attributes as Record<string, unknown>).contactEmail).toBe("dev@example.com");
      // demoAccountRequired: false must survive `compact`, which drops undefined
      // and must not drop a meaningful false.
      expect((data.attributes as Record<string, unknown>).demoAccountRequired).toBe(false);
      expect(data.relationships).toEqual({
        appStoreVersion: { data: { type: "appStoreVersions", id: VERSION_ID } },
      });
    });

    it("patches the existing detail instead of creating a second one", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ data: { id: "rd-existing", type: "appStoreReviewDetails" } }),
      );

      const result = await callTool(
        "app_store_connect_set_app_store_review_detail",
        { versionId: VERSION_ID, notes: "No account needed." },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('"created": false');
      expect(postCall(fetchImpl, "/v1/appStoreReviewDetails")).toBeUndefined();

      const patch = patchCall(fetchImpl);
      expect(patch?.[0]).toContain("/v1/appStoreReviewDetails/rd-existing");
    });

    it("reports a missing detail as null rather than a 404", async () => {
      const fetchImpl = vi.fn(async () => notFound());

      const result = await callTool(
        "app_store_connect_get_app_store_review_detail",
        { versionId: VERSION_ID },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("cannot be submitted");
    });
  });

  describe("set_app_price", () => {
    it("refuses a price point from another territory before pricing anything", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ data: [{ id: "usa-point", type: "appPricePoints", attributes: {} }] }),
      );

      const result = await callTool(
        "app_store_connect_set_app_price",
        {
          appId: APP_ID,
          pricePointId: "fra-point",
          baseTerritory: "USA",
          confirm: true,
        },
        fetchImpl,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not one of this app's USA price points");
      expect(postCall(fetchImpl, "/v1/appPriceSchedules")).toBeUndefined();
    });

    it("posts the schedule with the price inlined under `included`", async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        String(url).includes("/appPricePoints")
          ? jsonResponse({
              data: [
                {
                  id: "free-point",
                  type: "appPricePoints",
                  attributes: { customerPrice: "0.00", proceeds: "0.00" },
                },
              ],
            })
          : jsonResponse({ data: { id: "sched-1", type: "appPriceSchedules" } }),
      );

      const result = await callTool(
        "app_store_connect_set_app_price",
        { appId: APP_ID, pricePointId: "free-point", baseTerritory: "USA", confirm: true },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      // The response is relationships only, so the echoed price is the caller's
      // only confirmation of which amount landed.
      expect(textOf(result)).toContain('"customerPrice": "0.00"');

      const post = postCall(fetchImpl, "/v1/appPriceSchedules");
      const body = bodyOf(post?.[1]);
      const included = body.included as Record<string, unknown>[];
      expect(included[0]?.type).toBe("appPrices");
      // The placeholder id has to match on both sides or Apple rejects the create.
      const data = body.data as Record<string, unknown>;
      const rels = data.relationships as Record<string, { data?: { id?: string }[] }>;
      expect(rels.manualPrices?.data?.[0]?.id).toBe(included[0]?.id);
    });

    it("reports an unpriced app as null rather than a 404", async () => {
      const fetchImpl = vi.fn(async () => notFound());

      const result = await callTool(
        "app_store_connect_get_app_price_schedule",
        { appId: APP_ID },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("never been priced");
    });
  });

  describe("set_app_categories", () => {
    it("sends the category as a relationship, and null clears the secondary", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: "ai-1", type: "appInfos" } }));

      const result = await callTool(
        "app_store_connect_set_app_categories",
        { appInfoId: "ai-1", primaryCategory: "PRODUCTIVITY", secondaryCategory: null },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      const rels = (bodyOf(patchCall(fetchImpl)?.[1]).data as Record<string, unknown>)
        .relationships as Record<string, unknown>;

      expect(rels.primaryCategory).toEqual({
        data: { type: "appCategories", id: "PRODUCTIVITY" },
      });
      // Clearing is an explicit null relationship, and must stay distinguishable
      // from "not mentioned" — which is what `undefined` means here.
      expect(rels.secondaryCategory).toEqual({ data: null });
      expect(rels.primarySubcategoryOne).toBeUndefined();
    });
  });

  describe("update_app", () => {
    it("patches the content rights declaration", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: APP_ID, type: "apps" } }));

      const result = await callTool(
        "app_store_connect_update_app",
        { appId: APP_ID, contentRightsDeclaration: "USES_THIRD_PARTY_CONTENT" },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      const patch = patchCall(fetchImpl);
      expect(patch?.[0]).toContain(`/v1/apps/${APP_ID}`);
      expect(
        ((bodyOf(patch?.[1]).data as Record<string, unknown>).attributes as Record<string, unknown>)
          .contentRightsDeclaration,
      ).toBe("USES_THIRD_PARTY_CONTENT");
    });
  });
});
