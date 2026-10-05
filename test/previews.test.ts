import { createHash } from "node:crypto";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "#/client/auth";
import type { Config } from "#/config";
import { createServer } from "#/server";

// The content is irrelevant — Apple validates the video, the mock does not.
const FIXTURE_BYTES = Buffer.from("not really a quicktime movie, but bytes all the same");
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "asc-preview-"));
const FIXTURE_PATH = join(FIXTURE_DIR, "preview.mov");
writeFileSync(FIXTURE_PATH, FIXTURE_BYTES);

const baseConfig: Config = {
  keyId: "ABCD123456",
  issuerId: "69a6de70-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
  allowWrites: true,
  maxRetries: 3,
  tokenTtlSeconds: 1140,
  metadataRoot: "fastlane/metadata",
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const connect = async (fetchImpl: typeof fetch, config: Config = baseConfig): Promise<Client> => {
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

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

type Call = [string, RequestInit];
const calls = (fetchImpl: ReturnType<typeof vi.fn>): Call[] =>
  fetchImpl.mock.calls as unknown as Call[];

const API = "https://api.appstoreconnect.apple.com";
const UPLOAD_HOST = "https://upload.appstoreconnect.example";

type RouterOptions = {
  existingSets?: { id: string; previewType: string }[];
  /** Successive videoDeliveryState objects; `null` omits it, as an older payload would. */
  videoStates?: (unknown | null)[];
  assetState?: unknown;
  uploadResponses?: Response[];
};

const router = (opts: RouterOptions = {}): ReturnType<typeof vi.fn> => {
  const uploads = [...(opts.uploadResponses ?? [])];
  const states = [...(opts.videoStates ?? [{ state: "COMPLETE" }])];
  let lastState: unknown = states[0];

  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";

    if (url.startsWith(UPLOAD_HOST)) {
      return uploads.shift() ?? new Response(null, { status: 200 });
    }
    if (method === "GET" && url.includes("Localizations/") && url.includes("/appPreviewSets")) {
      return jsonResponse({
        data: (opts.existingSets ?? []).map((set) => ({
          type: "appPreviewSets",
          id: set.id,
          attributes: { previewType: set.previewType },
        })),
      });
    }
    if (method === "POST" && url.endsWith("/v1/appPreviewSets")) {
      return jsonResponse({ data: { type: "appPreviewSets", id: "pset-new" } }, 201);
    }
    if (method === "POST" && url.endsWith("/v1/appPreviews")) {
      return jsonResponse(
        {
          data: {
            type: "appPreviews",
            id: "prev-1",
            attributes: {
              uploadOperations: [
                {
                  method: "PUT",
                  url: `${UPLOAD_HOST}/part1`,
                  offset: 0,
                  length: FIXTURE_BYTES.byteLength,
                  requestHeaders: [{ name: "Content-Type", value: "video/quicktime" }],
                },
              ],
            },
          },
        },
        201,
      );
    }
    if (method === "PATCH" && url.includes("/v1/appPreviews/")) {
      return jsonResponse({ data: { type: "appPreviews", id: "prev-1", attributes: {} } });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "GET" && url.includes("/v1/appPreviews/")) {
      lastState = states.length > 0 ? states.shift() : lastState;
      return jsonResponse({
        data: {
          type: "appPreviews",
          id: "prev-1",
          attributes: {
            fileName: "preview.mov",
            assetDeliveryState: opts.assetState ?? { state: "COMPLETE" },
            ...(lastState === null ? {} : { videoDeliveryState: lastState }),
            previewFrameTimeCode: "00:00:00:00",
          },
        },
      });
    }
    return jsonResponse({ data: [] });
  });
};

const upload = async (
  client: Client,
  args: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<Client["callTool"]>>> =>
  client.callTool({
    name: "app_store_connect_upload_preview",
    arguments: {
      localizationId: "loc-1",
      previewType: "IPHONE_67",
      filePath: FIXTURE_PATH,
      waitSeconds: 0,
      ...args,
    },
  });

const patches = (fetchImpl: ReturnType<typeof vi.fn>): unknown[] =>
  calls(fetchImpl)
    .filter(([url, init]) => init.method === "PATCH" && url.includes("/v1/appPreviews/"))
    .map(([, init]) => JSON.parse(init.body as string).data.attributes);

describe("app_store_connect_upload_preview", () => {
  it("runs the full reservation flow against an existing set", async () => {
    const fetchImpl = router({ existingSets: [{ id: "pset-67", previewType: "IPHONE_67" }] });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { waitSeconds: 5 });
    expect(result.isError).toBeFalsy();

    const seen = calls(fetchImpl).map(([url, init]) => `${init.method ?? "GET"} ${url}`);
    expect(seen[0]).toContain("/v1/appStoreVersionLocalizations/loc-1/appPreviewSets");
    expect(seen).not.toContain(`POST ${API}/v1/appPreviewSets`);
    expect(seen[1]).toBe(`POST ${API}/v1/appPreviews`);
    expect(seen[2]).toBe(`PUT ${UPLOAD_HOST}/part1`);
    expect(seen[3]).toBe(`PATCH ${API}/v1/appPreviews/prev-1`);

    const reserve = JSON.parse(calls(fetchImpl)[1]![1].body as string);
    expect(reserve.data.attributes).toEqual({
      fileName: "preview.mov",
      fileSize: FIXTURE_BYTES.byteLength,
      mimeType: "video/quicktime",
    });
    expect(reserve.data.relationships.appPreviewSet.data).toEqual({
      type: "appPreviewSets",
      id: "pset-67",
    });
    expect(patches(fetchImpl)).toEqual([
      { uploaded: true, sourceFileChecksum: createHash("md5").update(FIXTURE_BYTES).digest("hex") },
    ]);

    expect(JSON.parse(textOf(result))).toMatchObject({
      id: "prev-1",
      state: "COMPLETE",
      previewSetId: "pset-67",
      previewSetCreated: false,
    });
  });

  it("creates the preview set when the device type has none", async () => {
    const fetchImpl = router({ existingSets: [{ id: "pset-ipad", previewType: "IPAD_105" }] });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { previewType: "DESKTOP" });
    expect(result.isError).toBeFalsy();

    const create = calls(fetchImpl).find(
      ([url, init]) => init.method === "POST" && url.endsWith("/v1/appPreviewSets"),
    );
    const body = JSON.parse(create![1].body as string);
    expect(body.data.attributes.previewType).toBe("DESKTOP");
    expect(body.data.relationships.appStoreVersionLocalization.data.id).toBe("loc-1");
    expect(JSON.parse(textOf(result)).previewSetCreated).toBe(true);
  });

  it("waits on the video state, not the asset state that completes first", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "pset-67", previewType: "IPHONE_67" }],
      videoStates: [{ state: "PROCESSING" }],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { waitSeconds: 0 });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.state).toBe("PROCESSING");
    expect(payload.stillProcessing).toBe(true);
    expect(payload.note).toContain("app_store_connect_get_preview");
  });

  it("falls back to the asset state when no video state is reported", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "pset-67", previewType: "IPHONE_67" }],
      videoStates: [null],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { waitSeconds: 5 });

    expect(JSON.parse(textOf(result)).state).toBe("COMPLETE");
  });

  it("reports Apple's rejection reason when processing FAILS", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "pset-67", previewType: "IPHONE_67" }],
      videoStates: [
        { state: "FAILED", errors: [{ code: "VIDEO_DURATION", description: "Too long: 42s" }] },
      ],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { waitSeconds: 5 });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("rejected the video");
    expect(text).toContain("Too long: 42s");
    expect(text).toContain("app_store_connect_delete_preview");
  });

  it("sets the poster frame once processing is complete", async () => {
    const fetchImpl = router({ existingSets: [{ id: "pset-67", previewType: "IPHONE_67" }] });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { waitSeconds: 5, previewFrameTimeCode: "00:00:07:01" });

    expect(result.isError).toBeFalsy();
    expect(patches(fetchImpl)[1]).toEqual({ previewFrameTimeCode: "00:00:07:01" });
    expect(JSON.parse(textOf(result))).toMatchObject({
      posterFrameSet: true,
      previewFrameTimeCode: "00:00:07:01",
    });
  });

  it("defers the poster frame while the video is still processing", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "pset-67", previewType: "IPHONE_67" }],
      videoStates: [{ state: "PROCESSING" }],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { waitSeconds: 0, previewFrameTimeCode: "00:00:07:01" });

    expect(result.isError).toBeFalsy();
    expect(patches(fetchImpl)).toHaveLength(1);
    const payload = JSON.parse(textOf(result));
    expect(payload.posterFrameSet).toBe(false);
    expect(payload.posterFrameNote).toContain("app_store_connect_set_preview_poster_frame");
  });

  it("deletes the dangling reservation when the upload hard-fails", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "pset-67", previewType: "IPHONE_67" }],
      uploadResponses: [new Response("expired", { status: 403 })],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client);

    expect(result.isError).toBe(true);
    const cleanup = calls(fetchImpl).find(([, init]) => init.method === "DELETE");
    expect(cleanup![0]).toBe(`${API}/v1/appPreviews/prev-1`);
  });

  it("refuses a file that is not a video container before any request", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { filePath: "/tmp/shot.png" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(".mov, .m4v or .mp4");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows a video over the image limit but refuses one over 500 MB", async () => {
    const path = join(FIXTURE_DIR, "huge.mp4");
    writeFileSync(path, "");
    truncateSync(path, 501 * 1024 * 1024);
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { filePath: path });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("over the 524288000-byte limit");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains the Docker path caveat without offering base64", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { filePath: "/nope/missing.mov" });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Docker");
    expect(text).not.toContain("fileData");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a screenshot display type and a malformed time code at the schema", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    expect((await upload(client, { previewType: "APP_IPHONE_67" })).isError).toBe(true);
    expect((await upload(client, { previewFrameTimeCode: "0:05" })).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("app preview read tools", () => {
  it("strips spent uploadOperations out of listed previews", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            type: "appPreviews",
            id: "prev-1",
            attributes: {
              fileName: "a.mov",
              uploadOperations: [{ url: `${UPLOAD_HOST}/secret-and-very-long` }],
            },
          },
        ],
      }),
    );
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_previews",
      arguments: { previewSetId: "pset-67" },
    });

    const text = textOf(result);
    expect(text).toContain("a.mov");
    expect(text).not.toContain("secret-and-very-long");
    expect(calls(fetchImpl)[0]![0]).toContain("/v1/appPreviewSets/pset-67/appPreviews");
  });
});

describe("app preview write tools", () => {
  it("are hidden when writes are disabled", async () => {
    const readOnly = await connect(router() as unknown as typeof fetch, {
      ...baseConfig,
      allowWrites: false,
    });
    const names = (await readOnly.listTools()).tools.map((t) => t.name);

    expect(names).toContain("app_store_connect_list_preview_sets");
    expect(names).toContain("app_store_connect_list_previews");
    expect(names).toContain("app_store_connect_get_preview");
    for (const name of [
      "app_store_connect_upload_preview",
      "app_store_connect_set_preview_poster_frame",
      "app_store_connect_delete_preview",
      "app_store_connect_delete_preview_set",
      "app_store_connect_reorder_previews",
    ]) {
      expect(names, name).not.toContain(name);
    }
  });

  it("refuse to delete without an explicit confirm", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_delete_preview_set",
      arguments: { previewSetId: "pset-67" },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reorder sends the full ordered relationship list", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_reorder_previews",
      arguments: { previewSetId: "pset-67", previewIds: ["b", "a"], confirm: true },
    });

    expect(result.isError).toBeFalsy();
    const [url, init] = calls(fetchImpl)[0]!;
    expect(url).toBe(`${API}/v1/appPreviewSets/pset-67/relationships/appPreviews`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string).data).toEqual([
      { type: "appPreviews", id: "b" },
      { type: "appPreviews", id: "a" },
    ]);
  });
});
