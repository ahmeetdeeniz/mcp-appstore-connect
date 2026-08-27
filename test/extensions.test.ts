import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "../src/client/auth.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { rawWritesEnabled } from "../src/tools/raw.js";

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

const connect = async (config: Config, fetchImpl: typeof fetch): Promise<Client> => {
  const { server } = createServer({
    config,
    fetch: fetchImpl,
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "extensions-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((tool) => tool.name).sort();

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("raw API safety latch", () => {
  it("parses only explicit truthy values", () => {
    expect(rawWritesEnabled({})).toBe(false);
    expect(rawWritesEnabled({ APP_STORE_CONNECT_ALLOW_RAW_WRITES: "0" })).toBe(false);
    expect(rawWritesEnabled({ APP_STORE_CONNECT_ALLOW_RAW_WRITES: "false" })).toBe(false);
    expect(rawWritesEnabled({ APP_STORE_CONNECT_ALLOW_RAW_WRITES: "1" })).toBe(true);
    expect(rawWritesEnabled({ APP_STORE_CONNECT_ALLOW_RAW_WRITES: "YES" })).toBe(true);
  });

  it("always exposes raw GET but needs both latches for raw mutation", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;

    const readOnly = await toolNames(await connect(baseConfig, fetchImpl));
    expect(readOnly).toContain("app_store_connect_raw_get");
    expect(readOnly).not.toContain("app_store_connect_raw_mutate");
    expect(readOnly).not.toContain("app_store_connect_raw_delete");

    const normalWrites = await toolNames(
      await connect({ ...baseConfig, allowWrites: true }, fetchImpl),
    );
    expect(normalWrites).not.toContain("app_store_connect_raw_mutate");
    expect(normalWrites).not.toContain("app_store_connect_raw_delete");

    vi.stubEnv("APP_STORE_CONNECT_ALLOW_RAW_WRITES", "1");
    const rawWrites = await toolNames(
      await connect({ ...baseConfig, allowWrites: true }, fetchImpl),
    );
    expect(rawWrites).toContain("app_store_connect_raw_mutate");
    expect(rawWrites).toContain("app_store_connect_raw_delete");
  });

  it("raw GET keeps the JWT on the ASC host and passes query separately", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: "app-1" }] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_raw_get",
      arguments: {
        path: "/v1/apps",
        query: { "filter[bundleId]": "com.acme.app", limit: 5 },
      },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://api.appstoreconnect.apple.com/v1/apps");
    expect(parsed.searchParams.get("filter[bundleId]")).toBe("com.acme.app");
    expect(parsed.searchParams.get("limit")).toBe("5");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-token");
  });
});

describe("release doctor", () => {
  it("reports automated readiness while keeping App Privacy manual", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));

      switch (url.pathname) {
        case "/v1/appStoreVersions/ver-1":
          return jsonResponse({
            data: {
              id: "ver-1",
              type: "appStoreVersions",
              attributes: {
                versionString: "1.0.0",
                platform: "IOS",
                appStoreState: "PREPARE_FOR_SUBMISSION",
                copyright: "2026 Acme",
              },
              relationships: {
                app: { data: { type: "apps", id: "app-1" } },
                build: { data: { type: "builds", id: "build-1" } },
              },
            },
            included: [
              {
                id: "build-1",
                type: "builds",
                attributes: { processingState: "VALID", expired: false },
              },
            ],
          });

        case "/v1/apps/app-1":
          return jsonResponse({
            data: {
              id: "app-1",
              type: "apps",
              attributes: {
                bundleId: "com.acme.app",
                primaryLocale: "en-US",
                contentRightsDeclaration: "DOES_NOT_USE_THIRD_PARTY_CONTENT",
              },
            },
          });

        case "/v1/apps/app-1/appStoreVersions":
          return jsonResponse({
            data: [
              {
                id: "ver-1",
                type: "appStoreVersions",
                attributes: {
                  versionString: "1.0.0",
                  platform: "IOS",
                  appStoreState: "PREPARE_FOR_SUBMISSION",
                },
              },
            ],
          });

        case "/v1/apps/app-1/appInfos":
          return jsonResponse({
            data: [
              {
                id: "info-1",
                type: "appInfos",
                attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" },
                relationships: {
                  primaryCategory: { data: { type: "appCategories", id: "GAMES" } },
                },
              },
            ],
          });

        case "/v1/appStoreVersions/ver-1/appStoreVersionLocalizations":
          return jsonResponse({
            data: [
              {
                id: "vloc-1",
                type: "appStoreVersionLocalizations",
                attributes: {
                  locale: "en-US",
                  description: "A useful app.",
                  keywords: "useful,app",
                  supportUrl: "https://example.com/support",
                },
              },
            ],
          });

        case "/v1/appInfos/info-1/appInfoLocalizations":
          return jsonResponse({
            data: [
              {
                id: "iloc-1",
                type: "appInfoLocalizations",
                attributes: {
                  locale: "en-US",
                  name: "Acme",
                  privacyPolicyUrl: "https://example.com/privacy",
                },
              },
            ],
          });

        case "/v1/apps/app-1/appPriceSchedule":
          return jsonResponse({
            data: { id: "price-1", type: "appPriceSchedules", attributes: {} },
          });

        case "/v1/appStoreVersions/ver-1/appStoreReviewDetail":
          return jsonResponse({
            data: {
              id: "review-1",
              type: "appStoreReviewDetails",
              attributes: {
                contactFirstName: "Ada",
                contactLastName: "Lovelace",
                contactEmail: "ada@example.com",
                contactPhone: "+1 555 0100",
                demoAccountRequired: false,
              },
            },
          });

        case "/v1/appInfos/info-1/ageRatingDeclaration":
          return jsonResponse({
            data: {
              id: "age-1",
              type: "ageRatingDeclarations",
              attributes: { socialMedia: false },
            },
          });

        case "/v1/appStoreVersionLocalizations/vloc-1/appScreenshotSets":
          return jsonResponse({
            data: [
              {
                id: "set-1",
                type: "appScreenshotSets",
                attributes: { screenshotDisplayType: "APP_IPHONE_67" },
              },
            ],
          });

        case "/v1/appScreenshotSets/set-1/appScreenshots":
          return jsonResponse({
            data: [
              {
                id: "shot-1",
                type: "appScreenshots",
                attributes: { fileName: "home.png", assetDeliveryState: { state: "COMPLETE" } },
              },
            ],
          });

        default:
          throw new Error(`Unexpected test request: ${url.pathname}${url.search}`);
      }
    });

    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_release_doctor",
      arguments: { versionId: "ver-1" },
    });
    const body = JSON.parse(textOf(result)) as {
      automatedReady: boolean;
      verdict: string;
      blockerCount: number;
      manualCheckCount: number;
    };

    expect(body.automatedReady).toBe(true);
    expect(body.blockerCount).toBe(0);
    expect(body.manualCheckCount).toBe(1);
    expect(body.verdict).toBe("manual_verification_required");
  });
});
