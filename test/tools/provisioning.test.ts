import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  baseConfig,
  callArgs,
  connect,
  jsonResponse,
  payloadOf,
  postCall,
  textOf,
  toolNames,
} from "../helpers.js";

describe("certificates", () => {
  const certAttributes = {
    certificateType: "DEVELOPER_ID_APPLICATION",
    displayName: "Magenta Creations",
    name: "Developer ID Application: Magenta Creations",
    platform: "MAC_OS",
    serialNumber: "1A2B3C",
    expirationDate: "2031-01-01T00:00:00.000+00:00",
    // Apple returns the certificate as base64 DER. "hello" as bytes.
    certificateContent: Buffer.from("hello").toString("base64"),
    csrContent: "-----BEGIN CERTIFICATE REQUEST-----\nblob\n-----END CERTIFICATE REQUEST-----",
  };

  const certResponse = (single = false): unknown => ({
    data: single
      ? { id: "cert-1", type: "certificates", attributes: certAttributes }
      : [{ id: "cert-1", type: "certificates", attributes: certAttributes }],
  });

  it("hides the mutating tools unless writes are allowed", async () => {
    const readOnly = await toolNames(await connect(baseConfig));
    expect(readOnly).toContain("app_store_connect_list_certificates");
    expect(readOnly).toContain("app_store_connect_download_certificate");
    expect(readOnly).not.toContain("app_store_connect_create_certificate");
    expect(readOnly).not.toContain("app_store_connect_revoke_certificate");

    const writable = await toolNames(await connect({ ...baseConfig, allowWrites: true }));
    expect(writable).toContain("app_store_connect_create_certificate");
    expect(writable).toContain("app_store_connect_revoke_certificate");
  });

  it("omits the base64 blobs from a listing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(certResponse()));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const text = textOf(
      await client.callTool({ name: "app_store_connect_list_certificates", arguments: {} }),
    );

    // The useful fields survive...
    expect(text).toContain("DEVELOPER_ID_APPLICATION");
    expect(text).toContain("1A2B3C");
    // ...and the multi-kilobyte ones do not reach the caller's context.
    expect(text).toContain("<omitted>");
    expect(text).not.toContain(certAttributes.certificateContent);
    expect(text).not.toContain("BEGIN CERTIFICATE REQUEST");
  });

  it("posts the CSR and writes decoded DER, not base64", async () => {
    const dir = await mkdtemp(join(tmpdir(), "certs-"));
    const savePath = join(dir, "nested", "devid.cer");
    const fetchImpl = vi.fn(async () => jsonResponse(certResponse(true)));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const text = textOf(
      await client.callTool({
        name: "app_store_connect_create_certificate",
        arguments: {
          certificateType: "DEVELOPER_ID_APPLICATION",
          csrContent: "-----BEGIN CERTIFICATE REQUEST-----\nabc\n-----END CERTIFICATE REQUEST-----",
          savePath,
        },
      }),
    );

    const post = postCall(fetchImpl, "/v1/certificates");
    expect(post).toBeDefined();
    const body = JSON.parse(String(post?.[1]?.body)) as {
      data: { attributes: Record<string, string> };
    };
    expect(body.data.attributes.certificateType).toBe("DEVELOPER_ID_APPLICATION");
    expect(body.data.attributes.csrContent).toContain("BEGIN CERTIFICATE REQUEST");

    // Decoded, so the file is importable rather than a base64 text blob.
    expect(await readFile(savePath)).toEqual(Buffer.from("hello"));
    expect(text).toContain(savePath);
    await rm(dir, { recursive: true, force: true });
  });

  // Both assertions describe protections the certificate path did not have
  // before it moved onto the shared writer: it wrote a relative path wherever
  // the server happened to be running, and said nothing about Docker mounts.
  it("refuses a relative savePath", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(certResponse(true)));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_download_certificate",
      arguments: { certificateId: "cert-1", savePath: "devid.cer" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("absolute path");
  });

  it("names the Docker mount when the write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-certs-"));
    const fetchImpl = vi.fn(async () => jsonResponse(certResponse(true)));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    // The directory itself is not a writable file path.
    const result = await client.callTool({
      name: "app_store_connect_download_certificate",
      arguments: { certificateId: "cert-1", savePath: dir },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Docker");
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the bytes it wrote alongside the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-certs-"));
    const savePath = join(dir, "devid.cer");
    const fetchImpl = vi.fn(async () => jsonResponse(certResponse(true)));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_certificate",
        arguments: { certificateId: "cert-1", savePath },
      }),
    ) as { saved: { path: string; bytes: number; content: string }; savedTo: string };

    expect(body.saved).toEqual({ path: savePath, bytes: 5, content: "binary" });
    // The receipt cannot disagree with the file it describes.
    expect(body.saved.bytes).toBe((await readFile(savePath)).byteLength);
    // Deprecated alias, kept for 0.23 so existing callers keep resolving a path.
    expect(body.savedTo).toBe(savePath);
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to revoke without an explicit confirm", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    const result = await client.callTool({
      name: "app_store_connect_revoke_certificate",
      arguments: { certificateId: "cert-1" },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("bundle id capabilities", () => {
  /**
   * Apple's answer to `WEATHERKIT`, captured from a live account — the accepted
   * list is elided, nothing else is. The `source.pointer` is what the hint keys
   * off, so it has to be here exactly as Apple sends it.
   */
  const rejectsType = (pointer = "/data/attributes/capabilityType"): Response =>
    new Response(
      JSON.stringify({
        errors: [
          {
            id: "035a9ac5-7f98-447a-a56b-5455fe377d44",
            status: "409",
            code: "ENTITY_ERROR.ATTRIBUTE.TYPE",
            title: "An attribute in the provided entity has the wrong type",
            detail:
              "'WEATHERKIT' is not a valid value for the attribute 'capabilityType'. Expected " +
              "one of: 'ICLOUD', 'IN_APP_PURCHASE', 'GAME_CENTER', 'PUSH_NOTIFICATIONS'",
            source: { pointer },
          },
        ],
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );

  it("lists the capabilities on a bundle id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { type: "bundleIdCapabilities", id: "cap-1", attributes: { capabilityType: "ICLOUD" } },
        ],
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_capabilities",
        arguments: { bundleId: "bid-1" },
      }),
    );

    const [url] = callArgs(fetchImpl);
    expect(url).toContain("/v1/bundleIds/bid-1/bundleIdCapabilities");
    // Apple rejects `limit` on this relationship with PARAMETER_ERROR.ILLEGAL
    // rather than ignoring it, so sending one fails the whole call.
    expect(new URL(url).search).toBe("");
    // The id disable_capability needs has to survive the summarizer.
    expect(JSON.stringify(body)).toContain("cap-1");
  });

  /**
   * The whole point of the hint: Apple's own answer lists the values it accepts
   * and says nothing about the portal, so the caller reads a permanent "cannot
   * be done here" as a typo and retries with a different spelling.
   */
  it("sends a portal-only capability to the portal, naming the App ID", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? rejectsType()
        : jsonResponse({
            data: {
              type: "bundleIds",
              id: "bid-1",
              attributes: { name: "Canopy", identifier: "com.acme.canopy" },
            },
          }),
    );
    const client = await connect(
      { ...baseConfig, allowWrites: true, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_enable_capability",
      arguments: { bundleId: "bid-1", capabilityType: "WEATHERKIT" },
    });

    expect(result.isError).toBe(true);
    const message = String(payloadOf(result).error);
    expect(message).toContain("App Services");
    expect(message).toContain("Canopy (com.acme.canopy)");
    expect(message).toContain("app_store_connect_list_capabilities");
    // Apple's own detail survives, so the accepted values stay visible.
    expect(message).toContain("'capabilityType'");
  });

  it("still names the capability when the App ID cannot be read back", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? rejectsType()
        : new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
    );
    const client = await connect(
      { ...baseConfig, allowWrites: true, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_enable_capability",
      arguments: { bundleId: "bid-1", capabilityType: "WEATHERKIT" },
    });

    expect(result.isError).toBe(true);
    // The lookup is a nicety; losing it must not lose the answer.
    expect(String(payloadOf(result).error)).toContain("bid-1");
  });

  /**
   * Nothing is validated locally against Apple's enum, so the day Apple adds a
   * capability the tool starts working without a release.
   */
  it("forwards an unknown capability type instead of refusing it locally", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          type: "bundleIdCapabilities",
          id: "cap-9",
          attributes: { capabilityType: "WEATHERKIT" },
        },
      }),
    );
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_enable_capability",
      arguments: { bundleId: "bid-1", capabilityType: "WEATHERKIT" },
    });

    expect(result.isError).toBeFalsy();
    const [, init] = callArgs(fetchImpl);
    expect(JSON.parse(String(init.body)).data.attributes.capabilityType).toBe("WEATHERKIT");
  });

  /**
   * Same code, same status, different attribute — `settings` is the other thing
   * this POST can get wrong, and it has nothing to do with the portal.
   */
  it("does not blame the portal for a 409 about another attribute", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST" ? rejectsType("/data/attributes/settings") : jsonResponse({}),
    );
    const client = await connect(
      { ...baseConfig, allowWrites: true, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_enable_capability",
      arguments: { bundleId: "bid-1", capabilityType: "ICLOUD", settings: [{ key: "nonsense" }] },
    });

    expect(result.isError).toBe(true);
    expect(String(payloadOf(result).error)).not.toContain("App Services");
  });

  it("leaves an unrelated failure alone", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ code: "FORBIDDEN_ERROR" }] }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = await connect(
      { ...baseConfig, allowWrites: true, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_enable_capability",
      arguments: { bundleId: "bid-1", capabilityType: "ICLOUD" },
    });

    expect(result.isError).toBe(true);
    const message = String(payloadOf(result).error);
    expect(message).toContain("FORBIDDEN_ERROR");
    expect(message).not.toContain("App Services");
  });
});
