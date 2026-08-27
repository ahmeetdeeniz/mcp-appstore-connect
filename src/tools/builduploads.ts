import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient, UploadOperation } from "../client/asc.js";
import { attributesOf, idOf, isRecord } from "./assets.js";
import { appIdArg, confirmArg, PreconditionError, wrap } from "./util.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readIpa = async (path: string): Promise<Buffer> => {
  if (!isAbsolute(path)) throw new PreconditionError("ipaPath must be an absolute path readable by the MCP server.", { ipaPath: path });
  if (!path.toLowerCase().endsWith(".ipa")) throw new PreconditionError("ipaPath must point to an .ipa file.", { ipaPath: path });
  const st = await stat(path);
  if (!st.isFile() || st.size === 0) throw new PreconditionError("The IPA is missing or empty.", { ipaPath: path });
  return readFile(path);
};

export const registerBuildUploadTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_get_build_upload",
    {
      description: "Read the state of an App Store Connect REST build-upload session.",
      inputSchema: { buildUploadId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ buildUploadId }) => wrap(async () => client.get(`/v1/buildUploads/${buildUploadId}`)),
  );

  server.registerTool(
    "app_store_connect_wait_for_build_processing",
    {
      description: "Poll until a build number for an app reaches VALID, terminates as INVALID/FAILED, or times out.",
      inputSchema: {
        appId: appIdArg,
        bundleVersion: z.string().min(1),
        pollIntervalSeconds: z.number().int().min(10).max(300).default(30),
        timeoutMinutes: z.number().int().min(1).max(180).default(45),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, bundleVersion, pollIntervalSeconds, timeoutMinutes }) => wrap(async () => {
      const deadline = Date.now() + timeoutMinutes * 60_000;
      for (;;) {
        const response = await client.get("/v1/builds", {
          "filter[app]": appId,
          "filter[version]": bundleVersion,
          sort: "-uploadedDate",
          limit: 5,
        });
        const rows = isRecord(response) && Array.isArray(response.data) ? response.data : [];
        const build = rows.find((row) => isRecord(row) && isRecord(row.attributes));
        if (isRecord(build) && isRecord(build.attributes)) {
          const state = build.attributes.processingState;
          if (state === "VALID") return { ok: true, state, buildId: build.id, attributes: build.attributes };
          if (state === "INVALID" || state === "FAILED") return { ok: false, state, buildId: build.id, attributes: build.attributes };
        }
        if (Date.now() >= deadline) return { ok: false, state: "TIMEOUT", note: "The build may still be processing in App Store Connect." };
        await sleep(pollIntervalSeconds * 1000);
      }
    }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_upload_ipa",
    {
      description:
        "Upload a built IPA using Apple's REST buildUploads flow. This reads the IPA from the MCP server machine, reserves the upload, sends the bytes to Apple's pre-signed URLs, commits checksums, and starts processing. Requires confirm:true because it creates a new build in App Store Connect.",
      inputSchema: {
        ipaPath: z.string().min(1),
        platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
        bundleVersion: z.string().min(1).describe("CFBundleVersion/build number contained in the IPA."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ ipaPath, platform, bundleVersion }) => wrap(async () => {
      const bytes = await readIpa(ipaPath);
      const fileName = basename(ipaPath);
      const created = await client.post("/v1/buildUploads", {
        data: { type: "buildUploads", attributes: { bundleVersion, platform } },
      });
      const buildUploadId = idOf(created);
      if (!buildUploadId) throw new Error("Creating buildUpload returned no id.");

      const reservation = await client.post("/v1/buildUploadFiles", {
        data: {
          type: "buildUploadFiles",
          attributes: { fileName, fileSize: bytes.byteLength, assetType: "BUILD" },
          relationships: { buildUpload: { data: { type: "buildUploads", id: buildUploadId } } },
        },
      });
      const fileId = idOf(reservation);
      if (!fileId) throw new Error("Creating buildUploadFile returned no id.");
      const attrs = attributesOf(reservation);
      const operations = (Array.isArray(attrs.uploadOperations) ? attrs.uploadOperations : []) as UploadOperation[];

      try {
        await client.uploadAsset(operations, bytes);
        const checksum = createHash("md5").update(bytes).digest("hex");
        await client.patch(`/v1/buildUploadFiles/${fileId}`, {
          data: { type: "buildUploadFiles", id: fileId, attributes: { uploaded: true, sourceFileChecksum: checksum } },
        });
        const final = await client.patch(`/v1/buildUploads/${buildUploadId}`, {
          data: { type: "buildUploads", id: buildUploadId, attributes: { uploaded: true } },
        });
        return {
          buildUploadId,
          fileId,
          fileName,
          fileSize: bytes.byteLength,
          state: attributesOf(final).state ?? "UPLOADED",
          note: "Apple is processing the build. Use app_store_connect_wait_for_build_processing next.",
        };
      } catch (error) {
        await client.del(`/v1/buildUploadFiles/${fileId}`).catch(() => undefined);
        throw error;
      }
    }),
  );
};
