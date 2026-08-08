import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient, Query, UploadOperation } from "../client/asc.js";
import { AppStoreConnectApiError } from "../client/errors.js";
import {
  attributesOf,
  includedOf,
  relatedId,
  resourceOf,
  resourcesOf,
  summarizeResponse,
} from "../client/shape.js";
// `attributesOf` exists in both modules and they are NOT interchangeable: the
// one from shape.js takes a resource, this one takes the whole response
// envelope. Aliased rather than imported bare so the two cannot be swapped by a
// tidy-up.
import { attributesOf as envelopeAttributes, idOf, pollAssetState, readImage } from "./assets.js";
import { PreconditionError, appIdArg, compact, confirmArg, limitArg, wrap } from "./util.js";

const IAP_TYPES = ["CONSUMABLE", "NON_CONSUMABLE", "NON_RENEWING_SUBSCRIPTION"] as const;

const inAppPurchaseIdArg = z
  .string()
  .min(1)
  .describe(
    "The inAppPurchase id (from app_store_connect_list_in_app_purchases), NOT the productId string.",
  );

const iapLocalizationIdArg = z
  .string()
  .min(1)
  .describe(
    "The inAppPurchaseLocalization id (from app_store_connect_list_iap_localizations). This is " +
      "NOT the inAppPurchase id, and NOT an appStoreVersionLocalization id.",
  );

/**
 * An in-app purchase's display name and description are far shorter than the
 * app-level fields people are used to — 30 and 45 — and Apple answers an
 * over-length value with a generic 409 that names neither the field nor the
 * limit. Checking here turns that into the one sentence the caller needs.
 *
 * Apple counts UTF-16 code units, which is exactly `String.length`, so an emoji
 * costs 2. Do not "fix" this to count code points.
 */
const IAP_FIELD_LIMITS = { name: 30, description: 45 } as const;

const assertWithinLimits = (fields: { name?: string; description?: string }): void => {
  for (const [field, limit] of Object.entries(IAP_FIELD_LIMITS)) {
    const value = fields[field as keyof typeof IAP_FIELD_LIMITS];
    if (value === undefined || value.length <= limit) continue;
    throw new PreconditionError(
      `The in-app purchase ${field} is ${value.length} characters, over Apple's ${limit}-character ` +
        `limit. Shorten it before retrying — App Store Connect rejects this without saying which ` +
        `field was too long.`,
      { field, limit, length: value.length, value },
    );
  }
};

/**
 * GET a to-one sub-resource that may never have been created, e.g. an IAP's
 * price schedule or its availability.
 *
 * Apple does not answer those with `data: null` — it answers **404**, with a
 * message naming the *parent's* id as though it were a missing resource of the
 * child's type ("no resource of type 'inAppPurchaseAvailabilities' with id
 * <the IAP id>"). Surfaced raw that reads as a broken request rather than as
 * "not configured yet", which is the one thing the caller actually needs to
 * know: it is the state every IAP starts in and the reason it sits at
 * MISSING_METADATA.
 */
const getOrNull = async <T>(
  client: AppStoreConnectClient,
  path: string,
  query?: Query,
): Promise<T | null> => {
  try {
    return await client.get<T>(path, query);
  } catch (err) {
    if (err instanceof AppStoreConnectApiError && err.status === 404) return null;
    throw err;
  }
};

/**
 * Apple keys territories by ISO-3166-1 alpha-3, and the base territory decides
 * which price point id is meaningful — a price point belongs to exactly one
 * territory, so USA's $4.99 and FRA's 5,99 € are different resources.
 */
const territoryArg = z
  .string()
  .length(3)
  .describe('Territory code (ISO-3166-1 alpha-3), e.g. "USA", "FRA", "JPN".');

/**
 * A price point id names a fixed amount in one territory, so pricing an IAP with
 * an id from the wrong territory silently charges the wrong amount. Apple accepts
 * that request, so the only place it can be caught is here, before the POST.
 */
const assertPricePointBelongs = async (
  client: AppStoreConnectClient,
  inAppPurchaseId: string,
  pricePointId: string,
  territory: string,
): Promise<Record<string, unknown>> => {
  const { data } = await client.getAll<Record<string, unknown>>(
    `/v2/inAppPurchases/${inAppPurchaseId}/pricePoints`,
    { "filter[territory]": territory, limit: 200 },
  );

  const match = data.find((point) => point.id === pricePointId);
  if (match !== undefined) return attributesOf(match);

  throw new PreconditionError(
    `Price point ${pricePointId} is not one of this in-app purchase's ${territory} price ` +
      `points. List them with app_store_connect_list_iap_price_points and pass an id from ` +
      `that response.`,
    { inAppPurchaseId, pricePointId, territory, availablePricePoints: data.length },
  );
};

export const registerIapTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_in_app_purchases",
    {
      description:
        "List an app's in-app purchases (name, productId, type, review state). Returns the " +
        "inAppPurchase ids the pricing tools take. Covers one-time purchases only — " +
        "auto-renewable subscriptions live under subscription groups and are not exposed here.",
      inputSchema: {
        appId: appIdArg,
        productId: z.string().optional().describe('Filter by productId, e.g. "com.acme.app.pro".'),
        name: z.string().optional().describe("Filter by display name."),
        inAppPurchaseType: z.enum(IAP_TYPES).optional().describe("Filter by purchase type."),
        state: z
          .string()
          .optional()
          .describe('Filter by review state, e.g. "APPROVED", "READY_TO_SUBMIT".'),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, productId, name, inAppPurchaseType, state, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/inAppPurchasesV2`,
            compact({
              "filter[productId]": productId,
              "filter[name]": name,
              "filter[inAppPurchaseType]": inAppPurchaseType,
              "filter[state]": state,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_in_app_purchase",
    {
      description: "Get one in-app purchase's attributes by its resource id.",
      inputSchema: { inAppPurchaseId: inAppPurchaseIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ inAppPurchaseId }) =>
      wrap(async () =>
        summarizeResponse(await client.get(`/v2/inAppPurchases/${inAppPurchaseId}`)),
      ),
  );

  server.registerTool(
    "app_store_connect_list_iap_price_points",
    {
      description:
        "List the price points available to an in-app purchase in one territory — each is an id " +
        "plus the customer-facing price and your proceeds. This is the catalogue you pick from: " +
        "pass the id of the row you want to app_store_connect_set_in_app_purchase_price. Apple " +
        "publishes hundreds per territory, so filter or raise the limit when hunting a " +
        "specific price.",
      inputSchema: {
        inAppPurchaseId: inAppPurchaseIdArg,
        territory: territoryArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ inAppPurchaseId, territory, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v2/inAppPurchases/${inAppPurchaseId}/pricePoints`, {
            "filter[territory]": territory,
            limit,
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_iap_price_schedule",
    {
      description:
        "Show what an in-app purchase currently costs: its base territory and every manual price " +
        "in force, each with the price point behind it and its start/end date. An empty price " +
        "list means the IAP has never been priced.",
      inputSchema: { inAppPurchaseId: inAppPurchaseIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ inAppPurchaseId }) =>
      wrap(async () => {
        // The schedule resource carries nothing but relationships, so the prices
        // only exist in `included` — summarizeResponse alone would return an id
        // and no prices at all.
        const response = await getOrNull(
          client,
          `/v2/inAppPurchases/${inAppPurchaseId}/iapPriceSchedule`,
          { include: "manualPrices,baseTerritory" },
        );
        if (response === null) {
          return { data: null, note: "This in-app purchase has never been priced." };
        }
        const schedule = resourceOf(response);

        return {
          scheduleId: schedule.id,
          baseTerritory: relatedId(schedule, "baseTerritory"),
          manualPrices: includedOf(response, "inAppPurchasePrices").map((price) => ({
            id: price.id,
            ...attributesOf(price),
            territory: relatedId(price, "territory"),
            pricePointId: relatedId(price, "inAppPurchasePricePoint"),
          })),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_list_iap_localizations",
    {
      description:
        "List an in-app purchase's per-locale display name and description — the customer-facing " +
        "copy shown on the purchase sheet, which is separate from the app's own listing. Returns " +
        "the localization ids the update and delete tools take. An IAP stuck at " +
        "`MISSING_METADATA` is usually missing these: Apple requires a display name, a " +
        "description and a review screenshot before it can be submitted.",
      inputSchema: { inAppPurchaseId: inAppPurchaseIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ inAppPurchaseId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v2/inAppPurchases/${inAppPurchaseId}/inAppPurchaseLocalizations`,
            compact({ limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_iap_review_screenshot",
    {
      description:
        "Get the review screenshot attached to an in-app purchase, including its " +
        "`assetDeliveryState` — the way to check whether an upload finished processing, and the " +
        "third thing Apple requires before an IAP leaves `MISSING_METADATA`. Returns nothing when " +
        "no screenshot has been attached.",
      inputSchema: { inAppPurchaseId: inAppPurchaseIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ inAppPurchaseId }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v2/inAppPurchases/${inAppPurchaseId}/appStoreReviewScreenshot`),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_iap_availability",
    {
      description:
        "Show which territories an in-app purchase is available in, and whether it opts into " +
        "territories Apple adds later. This is the fourth `MISSING_METADATA` requirement and the " +
        "easiest to miss: a name, a description, a price and a review screenshot can all be in " +
        "place and the IAP still will not become READY_TO_SUBMIT without it. `data: null` means " +
        "availability has never been set — use app_store_connect_set_iap_availability.",
      inputSchema: { inAppPurchaseId: inAppPurchaseIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ inAppPurchaseId, limit }) =>
      wrap(async () => {
        const response = await getOrNull(
          client,
          `/v2/inAppPurchases/${inAppPurchaseId}/inAppPurchaseAvailability`,
        );
        if (response === null) {
          return { data: null, note: "Availability has never been set for this in-app purchase." };
        }
        const availability = resourceOf(response);
        const availabilityId = availability.id;
        if (typeof availabilityId !== "string") return { data: null };

        // The territory list is a relationship, so it is absent from the
        // resource itself — without this the answer is "availability exists"
        // and not "available where", which is the actual question.
        const territories = await client.get(
          `/v1/inAppPurchaseAvailabilities/${availabilityId}/availableTerritories`,
          compact({ limit }),
        );
        return {
          id: availabilityId,
          ...attributesOf(availability),
          availableTerritories: resourcesOf(territories).map((t) => t.id),
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_set_in_app_purchase_price",
    {
      description:
        "Set what an in-app purchase costs, by pointing it at a price point from " +
        "app_store_connect_list_iap_price_points. Prices in every other territory are derived " +
        "from the base territory automatically, per Apple's equalization table. This REPLACES " +
        "the IAP's whole price schedule — any manual price already set is dropped — and once " +
        "the start date arrives it changes what real customers are charged. Omit startDate to " +
        "price it immediately.",
      inputSchema: {
        inAppPurchaseId: inAppPurchaseIdArg,
        pricePointId: z
          .string()
          .min(1)
          .describe(
            "The inAppPurchasePricePoint id to charge (from " +
              "app_store_connect_list_iap_price_points). Must belong to baseTerritory.",
          ),
        baseTerritory: territoryArg.describe(
          "The territory the price point belongs to and that every other territory is " +
            'derived from, e.g. "USA". Must match the territory you listed price points for.',
        ),
        startDate: z
          .string()
          .optional()
          .describe(
            'Date the price takes effect, "YYYY-MM-DD". Omit to apply it as soon as Apple ' +
              "processes the change.",
          ),
        endDate: z
          .string()
          .optional()
          .describe('Date the price stops applying, "YYYY-MM-DD". Omit to leave it open-ended.'),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ inAppPurchaseId, pricePointId, baseTerritory, startDate, endDate }) =>
      wrap(async () => {
        const pricePoint = await assertPricePointBelongs(
          client,
          inAppPurchaseId,
          pricePointId,
          baseTerritory,
        );

        // JSON:API inline create: `manualPrices` points at a placeholder id that
        // only resolves against the matching entry in `included`.
        const placeholder = "${new-price}";
        const response = await client.post("/v1/inAppPurchasePriceSchedules", {
          data: {
            type: "inAppPurchasePriceSchedules",
            relationships: {
              inAppPurchase: { data: { type: "inAppPurchases", id: inAppPurchaseId } },
              baseTerritory: { data: { type: "territories", id: baseTerritory } },
              manualPrices: { data: [{ type: "inAppPurchasePrices", id: placeholder }] },
            },
          },
          included: [
            {
              type: "inAppPurchasePrices",
              id: placeholder,
              attributes: compact({ startDate, endDate }),
              relationships: {
                inAppPurchasePricePoint: {
                  data: { type: "inAppPurchasePricePoints", id: pricePointId },
                },
              },
            },
          ],
        });

        // Echo the price we just set — the response is relationships only, so
        // without this the caller never sees which amount landed.
        return {
          ...(summarizeResponse(response) as Record<string, unknown>),
          priced: {
            pricePointId,
            baseTerritory,
            customerPrice: pricePoint.customerPrice,
            proceeds: pricePoint.proceeds,
            startDate: startDate ?? "immediate",
          },
        };
      }),
  );

  server.registerTool(
    "app_store_connect_set_iap_availability",
    {
      description:
        "Choose the territories an in-app purchase sells in — the requirement that keeps an " +
        "otherwise-complete IAP at `MISSING_METADATA`. Omit `territories` to make it available " +
        "everywhere the account sells, which is what the App Store Connect UI does by default " +
        "and what almost every one-time unlock wants. Availability can only be created once per " +
        "IAP; Apple rejects a second POST, so treat this as a first-time setup rather than an " +
        "edit.",
      inputSchema: {
        inAppPurchaseId: inAppPurchaseIdArg,
        territories: z
          .array(z.string().length(3))
          .optional()
          .describe(
            'Territory codes (ISO-3166-1 alpha-3), e.g. ["USA","FRA"]. Omit for every territory ' +
              "Apple currently offers.",
          ),
        availableInNewTerritories: z
          .boolean()
          .default(true)
          .describe(
            "Whether the IAP is added automatically to territories Apple opens later. Leaving " +
              "this false means a new App Store region silently cannot buy it.",
          ),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ inAppPurchaseId, territories, availableInNewTerritories }) =>
      wrap(async () => {
        // "Everywhere" has to be enumerated: the relationship takes explicit ids
        // and there is no wildcard, so an omitted list means read the catalogue.
        const resolved =
          territories ??
          resourcesOf(await client.get("/v1/territories", { limit: 200 })).flatMap((t) =>
            typeof t.id === "string" ? [t.id] : [],
          );

        if (resolved.length === 0) {
          throw new PreconditionError(
            "No territories resolved, so the in-app purchase would be available nowhere. Pass " +
              "`territories` explicitly.",
            { inAppPurchaseId },
          );
        }

        const response = await client.post("/v1/inAppPurchaseAvailabilities", {
          data: {
            type: "inAppPurchaseAvailabilities",
            attributes: { availableInNewTerritories },
            relationships: {
              // `inAppPurchase` here, NOT `inAppPurchaseV2` — this endpoint is
              // the one place Apple did not carry the v2 suffix across.
              inAppPurchase: { data: { type: "inAppPurchases", id: inAppPurchaseId } },
              availableTerritories: {
                data: resolved.map((id) => ({ type: "territories", id })),
              },
            },
          },
        });

        return {
          ...(summarizeResponse(response) as Record<string, unknown>),
          territoryCount: resolved.length,
          availableInNewTerritories,
        };
      }),
  );

  server.registerTool(
    "app_store_connect_update_in_app_purchase",
    {
      description:
        "Update an in-app purchase's own attributes: reference name, review note, and Family " +
        "Sharing. Only the fields you pass are changed. `familySharable` is the one that cannot " +
        "be walked back — once an IAP has shipped with Family Sharing on, turning it off is a " +
        "takeback from customers who already bought it, so Apple treats it as one-way in " +
        "practice. `name` here is the internal reference name, NOT what customers see: that is " +
        "the per-locale display name, set with app_store_connect_create_iap_localization.",
      inputSchema: {
        inAppPurchaseId: inAppPurchaseIdArg,
        name: z
          .string()
          .optional()
          .describe(
            "Internal reference name shown in App Store Connect (30-char limit). Not " +
              "customer-facing.",
          ),
        reviewNote: z
          .string()
          .optional()
          .describe(
            "Note to App Review explaining how to reach and test the purchase. Shown only to " +
              "Apple.",
          ),
        familySharable: z
          .boolean()
          .optional()
          .describe(
            "Whether one purchase covers the buyer's Family Sharing group. Enabling it is safe; " +
              "disabling it after customers have bought is a takeback.",
          ),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ inAppPurchaseId, confirm: _confirm, ...attributes }) =>
      wrap(async () => {
        assertWithinLimits(attributes);
        return summarizeResponse(
          await client.patch(`/v2/inAppPurchases/${inAppPurchaseId}`, {
            data: {
              type: "inAppPurchases",
              id: inAppPurchaseId,
              attributes: compact(attributes),
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_create_iap_localization",
    {
      description:
        "Add the customer-facing display name and description for one locale of an in-app " +
        "purchase — two of the three things Apple requires before an IAP can leave " +
        "`MISSING_METADATA` (the third is a review screenshot). The limits are much tighter than " +
        "the app's own listing: 30 characters for the name, 45 for the description. Use " +
        "app_store_connect_update_iap_localization to change a locale that already exists; " +
        "creating a duplicate locale is rejected.",
      inputSchema: {
        inAppPurchaseId: inAppPurchaseIdArg,
        locale: z
          .string()
          .min(2)
          .describe('The locale to create, e.g. "en-US". One localization per locale.'),
        name: z
          .string()
          .describe("Display name customers see on the purchase sheet (30-char limit)."),
        description: z
          .string()
          .optional()
          .describe("What the purchase unlocks, shown to customers (45-char limit)."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ inAppPurchaseId, locale, name, description }) =>
      wrap(async () => {
        assertWithinLimits({ name, description });
        return summarizeResponse(
          await client.post("/v1/inAppPurchaseLocalizations", {
            data: {
              type: "inAppPurchaseLocalizations",
              attributes: compact({ name, locale, description }),
              // `inAppPurchaseV2`, not `inAppPurchase` — the v2 resource kept the
              // suffixed relationship name, and the obvious spelling 409s.
              relationships: {
                inAppPurchaseV2: { data: { type: "inAppPurchases", id: inAppPurchaseId } },
              },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_update_iap_localization",
    {
      description:
        "Change the display name or description of one existing in-app purchase locale. Only the " +
        "fields you pass are changed. Name is limited to 30 characters and description to 45.",
      inputSchema: {
        localizationId: iapLocalizationIdArg,
        name: z
          .string()
          .optional()
          .describe("Display name customers see on the purchase sheet (30-char limit)."),
        description: z
          .string()
          .optional()
          .describe("What the purchase unlocks, shown to customers (45-char limit)."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ localizationId, confirm: _confirm, ...attributes }) =>
      wrap(async () => {
        assertWithinLimits(attributes);
        return summarizeResponse(
          await client.patch(`/v1/inAppPurchaseLocalizations/${localizationId}`, {
            data: {
              type: "inAppPurchaseLocalizations",
              id: localizationId,
              attributes: compact(attributes),
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_delete_iap_localization",
    {
      description:
        "Remove one locale's display name and description from an in-app purchase. Deleting the " +
        "last remaining locale puts the IAP back into `MISSING_METADATA` and blocks submission.",
      inputSchema: { localizationId: iapLocalizationIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ localizationId }) =>
      wrap(async () => {
        await client.del(`/v1/inAppPurchaseLocalizations/${localizationId}`);
        return { deleted: localizationId };
      }),
  );

  server.registerTool(
    "app_store_connect_upload_iap_review_screenshot",
    {
      description:
        "Attach the review screenshot an in-app purchase needs before it can be submitted — the " +
        "third `MISSING_METADATA` requirement alongside a display name and description. Runs the " +
        "whole flow: reserves the asset, uploads the bytes, commits the checksum, then waits for " +
        "processing. This is shown to App Review only, never to customers, and an IAP holds " +
        "exactly one: uploading again replaces it.",
      inputSchema: {
        inAppPurchaseId: inAppPurchaseIdArg,
        filePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to a PNG/JPEG readable BY THIS SERVER. If the server runs in Docker, " +
              "this must be a path inside the container.",
          ),
        fileData: z
          .string()
          .optional()
          .describe(
            "Base64-encoded image bytes, as an alternative to `filePath` for a containerized " +
              "server. Requires `fileName`. Small images only — this travels through the " +
              "conversation.",
          ),
        fileName: z
          .string()
          .optional()
          .describe(
            "Name to register with App Store Connect. Defaults to the basename of `filePath`. " +
              "Required with `fileData`.",
          ),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(180)
          .default(60)
          .describe(
            "How long to wait for processing to finish (0 = don't wait). Timing out is not a " +
              "failure — the upload has already succeeded at that point.",
          ),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ inAppPurchaseId, filePath, fileData, fileName, waitSeconds }) =>
      wrap(async () => {
        const { bytes, name } = await readImage(filePath, fileData, fileName, "review screenshot");

        const reserved = await client.post("/v1/inAppPurchaseAppStoreReviewScreenshots", {
          data: {
            type: "inAppPurchaseAppStoreReviewScreenshots",
            attributes: { fileName: name, fileSize: bytes.byteLength },
            relationships: {
              inAppPurchaseV2: { data: { type: "inAppPurchases", id: inAppPurchaseId } },
            },
          },
        });
        const screenshotId = idOf(reserved);
        if (!screenshotId) throw new Error("Reserving the review screenshot returned no id.");
        const operations = (() => {
          const ops = envelopeAttributes(reserved).uploadOperations;
          return (Array.isArray(ops) ? ops : []) as UploadOperation[];
        })();

        try {
          await client.uploadAsset(operations, bytes);
          await client.patch(`/v1/inAppPurchaseAppStoreReviewScreenshots/${screenshotId}`, {
            data: {
              type: "inAppPurchaseAppStoreReviewScreenshots",
              id: screenshotId,
              attributes: {
                uploaded: true,
                sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
              },
            },
          });
        } catch (err) {
          // An uncommitted reservation is invisible in the App Store Connect UI
          // but still blocks submission, and carries no diagnostic value.
          await client
            .del(`/v1/inAppPurchaseAppStoreReviewScreenshots/${screenshotId}`)
            .catch(() => undefined);
          throw err;
        }

        return pollAssetState(client, {
          resourcePath: "/v1/inAppPurchaseAppStoreReviewScreenshots",
          assetId: screenshotId,
          waitSeconds,
          meta: { inAppPurchaseId, fileName: name, fileSize: bytes.byteLength },
          failureHint:
            "A review screenshot must be a screenshot of the purchase inside your app, at a " +
            "supported device resolution and with no alpha channel.",
          deleteToolName: "app_store_connect_get_iap_review_screenshot (then delete it in the UI)",
          pollToolName: "app_store_connect_get_iap_review_screenshot",
        });
      }),
  );

  server.registerTool(
    "app_store_connect_submit_in_app_purchase_for_review",
    {
      description:
        "Submit an in-app purchase to Apple for review. The IAP must already be " +
        "`READY_TO_SUBMIT` — that means a display name, a description, a price and a review " +
        "screenshot are all in place; check `state` with app_store_connect_get_in_app_purchase " +
        "first, because `MISSING_METADATA` is refused here. A first-ever IAP is reviewed " +
        "alongside the app version that introduces it, so it also needs that version submitted.",
      inputSchema: { inAppPurchaseId: inAppPurchaseIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ inAppPurchaseId }) =>
      wrap(async () => {
        const state = attributesOf(
          resourceOf(await client.get(`/v2/inAppPurchases/${inAppPurchaseId}`)),
        ).state;
        if (state !== "READY_TO_SUBMIT") {
          throw new PreconditionError(
            `This in-app purchase is ${String(state)}, not READY_TO_SUBMIT, so Apple will refuse ` +
              `the submission. MISSING_METADATA means it still needs a display name and ` +
              `description (app_store_connect_list_iap_localizations), a price ` +
              `(app_store_connect_get_iap_price_schedule) or a review screenshot ` +
              `(app_store_connect_get_iap_review_screenshot).`,
            { inAppPurchaseId, state },
          );
        }

        return summarizeResponse(
          await client.post("/v1/inAppPurchaseSubmissions", {
            data: {
              type: "inAppPurchaseSubmissions",
              relationships: {
                inAppPurchaseV2: { data: { type: "inAppPurchases", id: inAppPurchaseId } },
              },
            },
          }),
        );
      }),
  );
};
