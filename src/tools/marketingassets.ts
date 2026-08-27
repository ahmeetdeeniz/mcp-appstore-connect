import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient, UploadOperation } from "../client/asc.js";
import { idOf, pollAssetState, readImage } from "./assets.js";
import { confirmArg, wrap } from "./util.js";

const CPP_DISPLAY_TYPES = [
  "APP_IPHONE_67",
  "APP_IPHONE_61",
  "APP_IPHONE_65",
  "APP_IPHONE_58",
  "APP_IPHONE_55",
  "APP_IPHONE_47",
  "APP_IPHONE_40",
  "APP_IPHONE_35",
  "APP_IPAD_PRO_3GEN_129",
  "APP_IPAD_PRO_3GEN_11",
  "APP_IPAD_PRO_129",
  "APP_IPAD_105",
  "APP_IPAD_97",
  "APP_DESKTOP",
  "APP_WATCH_ULTRA",
  "APP_WATCH_SERIES_7",
  "APP_WATCH_SERIES_4",
  "APP_WATCH_SERIES_3",
  "APP_APPLE_TV",
  "APP_APPLE_VISION_PRO",
] as const;

const EVENT_ASSET_TYPES = ["EVENT_CARD", "EVENT_DETAILS_PAGE"] as const;

const fileArgs = {
  filePath: z.string().optional().describe("Absolute path readable by the MCP server."),
  fileData: z.string().optional().describe("Base64 image bytes; use when the server cannot read your host path."),
  fileName: z.string().optional().describe("Required with fileData; optional override with filePath."),
};

const uploadReservedImage = async (
  client: AppStoreConnectClient,
  opts: {
    reservePath: string;
    resourceType: string;
    relationshipName: string;
    relationshipType: string;
    relationshipId: string;
    attributes?: Record<string, unknown>;
    filePath?: string;
    fileData?: string;
    fileName?: string;
    what: string;
    waitSeconds: number;
    failureHint: string;
    deleteToolName: string;
    pollToolName: string;
  },
): Promise<unknown> => {
  const { bytes, name } = await readImage(opts.filePath, opts.fileData, opts.fileName, opts.what);
  const reserved = await client.post(opts.reservePath, {
    data: {
      type: opts.resourceType,
      attributes: {
        fileName: name,
        fileSize: bytes.byteLength,
        ...(opts.attributes ?? {}),
      },
      relationships: {
        [opts.relationshipName]: {
          data: { type: opts.relationshipType, id: opts.relationshipId },
        },
      },
    },
  });
  const assetId = idOf(reserved);
  if (!assetId) throw new Error(`Reserving the ${opts.what} returned no id.`);
  const attrs =
    typeof reserved === "object" && reserved !== null && "data" in reserved
      ? (reserved as { data?: { attributes?: { uploadOperations?: UploadOperation[] } } }).data?.attributes
      : undefined;
  const operations = attrs?.uploadOperations ?? [];

  try {
    await client.uploadAsset(operations, bytes);
    await client.patch(`${opts.reservePath}/${assetId}`, {
      data: {
        type: opts.resourceType,
        id: assetId,
        attributes: {
          uploaded: true,
          sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
        },
      },
    });
  } catch (err) {
    await client.del(`${opts.reservePath}/${assetId}`).catch(() => undefined);
    throw err;
  }

  return pollAssetState(client, {
    resourcePath: opts.reservePath,
    assetId,
    waitSeconds: opts.waitSeconds,
    meta: { fileName: name, fileSize: bytes.byteLength, parts: operations.length },
    failureHint: opts.failureHint,
    deleteToolName: opts.deleteToolName,
    pollToolName: opts.pollToolName,
  });
};

export const registerMarketingAssetTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_custom_page_screenshot_sets",
    {
      description:
        "List screenshot sets attached to one Custom Product Page localization. Returns the set ids and display types used by upload/reorder tools.",
      inputSchema: { customProductPageLocalizationId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ customProductPageLocalizationId }) =>
      wrap(async () =>
        client.get(
          `/v1/appCustomProductPageLocalizations/${customProductPageLocalizationId}/appScreenshotSets`,
          { limit: 50 },
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_app_event_screenshots",
    {
      description:
        "List the image assets attached to one In-App Event localization, including processing state and asset type.",
      inputSchema: { appEventLocalizationId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ appEventLocalizationId }) =>
      wrap(async () =>
        client.get(`/v1/appEventLocalizations/${appEventLocalizationId}/appEventScreenshots`, {
          limit: 50,
        }),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_upload_custom_page_screenshot",
    {
      description:
        "Upload a screenshot directly to a Custom Product Page localization. Reuses the existing set for displayType or creates it first, then performs Apple's reserve/upload/checksum/poll flow.",
      inputSchema: {
        customProductPageLocalizationId: z.string().min(1),
        displayType: z.enum(CPP_DISPLAY_TYPES),
        ...fileArgs,
        waitSeconds: z.number().int().min(0).max(120).default(30),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ customProductPageLocalizationId, displayType, filePath, fileData, fileName, waitSeconds }) =>
      wrap(async () => {
        const sets = await client.get(
          `/v1/appCustomProductPageLocalizations/${customProductPageLocalizationId}/appScreenshotSets`,
          { limit: 50 },
        );
        const rows =
          typeof sets === "object" && sets !== null && "data" in sets && Array.isArray((sets as { data?: unknown[] }).data)
            ? ((sets as { data: Array<{ id?: string; attributes?: { screenshotDisplayType?: string } }> }).data)
            : [];
        let setId = rows.find((row) => row.attributes?.screenshotDisplayType === displayType)?.id;
        if (!setId) {
          const created = await client.post("/v1/appScreenshotSets", {
            data: {
              type: "appScreenshotSets",
              attributes: { screenshotDisplayType: displayType },
              relationships: {
                appCustomProductPageLocalization: {
                  data: {
                    type: "appCustomProductPageLocalizations",
                    id: customProductPageLocalizationId,
                  },
                },
              },
            },
          });
          setId = idOf(created);
        }
        if (!setId) throw new Error("Creating the Custom Product Page screenshot set returned no id.");

        return uploadReservedImage(client, {
          reservePath: "/v1/appScreenshots",
          resourceType: "appScreenshots",
          relationshipName: "appScreenshotSet",
          relationshipType: "appScreenshotSets",
          relationshipId: setId,
          filePath,
          fileData,
          fileName,
          what: "Custom Product Page screenshot",
          waitSeconds,
          failureHint: `Check the pixel dimensions and alpha channel for ${displayType}.`,
          deleteToolName: "app_store_connect_delete_screenshot",
          pollToolName: "app_store_connect_get_screenshot",
        });
      }),
  );

  server.registerTool(
    "app_store_connect_upload_app_event_image",
    {
      description:
        "Upload an In-App Event image for EVENT_CARD or EVENT_DETAILS_PAGE. Performs the complete reservation, multipart upload, checksum commit and processing poll.",
      inputSchema: {
        appEventLocalizationId: z.string().min(1),
        assetType: z.enum(EVENT_ASSET_TYPES),
        ...fileArgs,
        waitSeconds: z.number().int().min(0).max(120).default(30),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appEventLocalizationId, assetType, filePath, fileData, fileName, waitSeconds }) =>
      wrap(async () =>
        uploadReservedImage(client, {
          reservePath: "/v1/appEventScreenshots",
          resourceType: "appEventScreenshots",
          relationshipName: "appEventLocalization",
          relationshipType: "appEventLocalizations",
          relationshipId: appEventLocalizationId,
          attributes: { appEventAssetType: assetType },
          filePath,
          fileData,
          fileName,
          what: "In-App Event image",
          waitSeconds,
          failureHint:
            "In-App Event card/details images have strict dimensions and Apple rejects transparency or unsupported files during processing.",
          deleteToolName: "app_store_connect_delete_app_event_image",
          pollToolName: "app_store_connect_list_app_event_screenshots",
        }),
      ),
  );

  server.registerTool(
    "app_store_connect_delete_app_event_image",
    {
      description: "Delete an In-App Event image. Use after a failed upload or when replacing artwork.",
      inputSchema: { appEventScreenshotId: z.string().min(1), confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ appEventScreenshotId }) =>
      wrap(async () => {
        await client.del(`/v1/appEventScreenshots/${appEventScreenshotId}`);
        return { deleted: appEventScreenshotId };
      }),
  );
};
