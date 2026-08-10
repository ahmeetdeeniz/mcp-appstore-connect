import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import {
  attributesOf,
  includedOf,
  relatedId,
  resourceOf,
  summarizeResponse,
} from "../client/shape.js";
import {
  PreconditionError,
  appIdArg,
  compact,
  confirmArg,
  getOrNull,
  limitArg,
  territoryArg,
  wrap,
} from "./util.js";

// The app's OWN price is a separate resource from any in-app purchase's, and
// having priced the IAP does nothing for it: a version cannot be submitted until
// /v2/appPrices has a schedule, and Apple reports that as
// STATE_ERROR.APP_PRICING_REQUIRED with no pointer to which resource is meant.
// A free app still has to say so — "free" is a price point, not the absence of
// one, which is why an app nobody ever charged for is still blocked.

/**
 * A price point id names a fixed amount in one territory, so pricing an app with
 * an id from the wrong territory silently charges the wrong amount. Apple accepts
 * that request, so the only place it can be caught is here, before the POST.
 */
const assertPricePointBelongs = async (
  client: AppStoreConnectClient,
  appId: string,
  pricePointId: string,
  territory: string,
): Promise<Record<string, unknown>> => {
  const { data } = await client.getAll<Record<string, unknown>>(
    `/v1/apps/${appId}/appPricePoints`,
    {
      "filter[territory]": territory,
      limit: 200,
    },
  );

  const match = data.find((point) => point.id === pricePointId);
  if (match !== undefined) return attributesOf(match);

  throw new PreconditionError(
    `Price point ${pricePointId} is not one of this app's ${territory} price points. List them ` +
      `with app_store_connect_list_app_price_points and pass an id from that response.`,
    { appId, pricePointId, territory, availablePricePoints: data.length },
  );
};

/**
 * Flatten a price schedule's `manualPrices` into rows that carry the actual money.
 *
 * An `appPrice` / `inAppPurchasePrice` has almost no attributes of its own: the
 * amount lives on the related price point and the territory on a related
 * territory, so both are reachable only by sideloading. Ask for `manualPrices`
 * alone — as this did — and Apple returns neither relationship, `relatedId`
 * yields `undefined` at every hop, and `JSON.stringify` drops undefined keys, so
 * `territory` and `pricePointId` do not come back *absent*, they come back
 * invisible. The result is a price schedule that answers "what does this app
 * cost" with an opaque id and nothing else, leaving the caller to base64-decode
 * the id or page hundreds of price points to find out that the app is free.
 *
 * Inlining `customerPrice` and `proceeds` from the sideloaded price point makes
 * the one call that claims to answer the question actually answer it.
 */
export const manualPriceRows = (
  response: unknown,
  priceType: string,
  pricePointRelationship: string,
  pricePointType: string,
): Record<string, unknown>[] => {
  const pricePoints = new Map<string, Record<string, unknown>>();
  for (const point of includedOf(response, pricePointType)) {
    if (typeof point.id === "string") pricePoints.set(point.id, attributesOf(point));
  }

  return includedOf(response, priceType).map((price) => {
    const pricePointId = relatedId(price, pricePointRelationship);
    const point = pricePointId === undefined ? undefined : pricePoints.get(pricePointId);
    return {
      id: price.id,
      ...attributesOf(price),
      ...compact({
        territory: relatedId(price, "territory"),
        pricePointId,
        customerPrice: point?.customerPrice,
        proceeds: point?.proceeds,
      }),
    };
  });
};

export const registerPricingTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_app_price_points",
    {
      description:
        "List the price points an app can be sold at in one territory, each with its customer " +
        "price and your proceeds. Returns the appPricePoints ids that " +
        "app_store_connect_set_app_price takes. A free app uses the price point whose " +
        "customerPrice is 0 — filter for it rather than assuming an id.",
      inputSchema: {
        appId: appIdArg,
        territory: territoryArg.describe(
          'Territory to list prices for, e.g. "USA". Price points are per-territory, and the ' +
            "one you pass here must be the same territory you later set as baseTerritory.",
        ),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, territory, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/appPricePoints`,
            compact({ "filter[territory]": territory, limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_app_price_schedule",
    {
      description:
        "Show what an app currently costs: its base territory and every manual price in force, " +
        "each with its territory, its customerPrice and proceeds, and its start/end date. A " +
        "customerPrice of 0 is how a free app is priced. A null result means the app has never " +
        "been priced, which blocks submission — this is the check for " +
        "STATE_ERROR.APP_PRICING_REQUIRED.",
      inputSchema: { appId: appIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId }) =>
      wrap(async () => {
        // The schedule resource carries nothing but relationships, so the prices
        // only exist in `included` — summarizeResponse alone would return an id
        // and no prices at all. The nested includes are what make each price
        // legible; see manualPriceRows.
        const response = await getOrNull(client, `/v1/apps/${appId}/appPriceSchedule`, {
          include: "manualPrices.appPricePoint,manualPrices.territory,baseTerritory",
        });
        if (response === null) {
          return {
            data: null,
            note:
              "This app has never been priced, so it cannot be submitted. Set a price with " +
              "app_store_connect_set_app_price — a free app needs the 0 price point, not no price.",
          };
        }
        const schedule = resourceOf(response);

        return {
          scheduleId: schedule.id,
          baseTerritory: relatedId(schedule, "baseTerritory"),
          manualPrices: manualPriceRows(response, "appPrices", "appPricePoint", "appPricePoints"),
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_set_app_price",
    {
      description:
        "Set what an app costs, by pointing it at a price point from " +
        "app_store_connect_list_app_price_points. Prices in every other territory are derived " +
        "from the base territory automatically, per Apple's equalization table. This REPLACES " +
        "the app's whole price schedule — any manual price already set is dropped — and once the " +
        "start date arrives it changes what real customers are charged. Omit startDate to price " +
        "it immediately. To make an app free, pass the price point whose customerPrice is 0.",
      inputSchema: {
        appId: appIdArg,
        pricePointId: z
          .string()
          .min(1)
          .describe(
            "The appPricePoint id to charge (from app_store_connect_list_app_price_points). " +
              "Must belong to baseTerritory.",
          ),
        baseTerritory: territoryArg.describe(
          "The territory the price point belongs to and that every other territory is derived " +
            'from, e.g. "USA". Must match the territory you listed price points for.',
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
    async ({ appId, pricePointId, baseTerritory, startDate, endDate }) =>
      wrap(async () => {
        const pricePoint = await assertPricePointBelongs(
          client,
          appId,
          pricePointId,
          baseTerritory,
        );

        // JSON:API inline create: `manualPrices` points at a placeholder id that
        // only resolves against the matching entry in `included`.
        const placeholder = "${new-price}";
        const response = await client.post("/v1/appPriceSchedules", {
          data: {
            type: "appPriceSchedules",
            relationships: {
              app: { data: { type: "apps", id: appId } },
              baseTerritory: { data: { type: "territories", id: baseTerritory } },
              manualPrices: { data: [{ type: "appPrices", id: placeholder }] },
            },
          },
          included: [
            {
              type: "appPrices",
              id: placeholder,
              attributes: compact({ startDate, endDate }),
              relationships: {
                appPricePoint: { data: { type: "appPricePoints", id: pricePointId } },
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
};
