import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { attributesOf, summarizeResponse } from "../client/shape.js";
import { PreconditionError, confirmArg, limitArg, territoryArg, wrap } from "./util.js";

const OFFER_DURATIONS = [
  "THREE_DAYS",
  "ONE_WEEK",
  "TWO_WEEKS",
  "ONE_MONTH",
  "TWO_MONTHS",
  "THREE_MONTHS",
  "SIX_MONTHS",
  "ONE_YEAR",
] as const;
const OFFER_MODES = ["FREE_TRIAL", "PAY_AS_YOU_GO", "PAY_UP_FRONT"] as const;
const ELIGIBILITIES = ["NEW", "EXISTING", "EXPIRED"] as const;
const OFFER_ELIGIBILITIES = ["STACK_WITH_INTRO_OFFERS", "REPLACE_INTRO_OFFERS"] as const;
const WIN_BACK_PRIORITIES = ["HIGH", "NORMAL"] as const;
const PROMOTION_INTENTS = ["NOT_PROMOTED", "USE_AUTO_GENERATED_ASSETS"] as const;

const subscriptionIdArg = z.string().min(1).describe("The auto-renewable subscription id.");

const resolvePricePoint = async (
  client: AppStoreConnectClient,
  subscriptionId: string,
  territory: string,
  customerPrice: string,
): Promise<string> => {
  const { data } = await client.getAll<Record<string, unknown>>(
    `/v1/subscriptions/${subscriptionId}/pricePoints`,
    {
      "filter[territory]": territory,
      limit: 200,
      "fields[subscriptionPricePoints]": ["customerPrice", "proceeds"],
    },
  );
  const match = data.find((row) => attributesOf(row).customerPrice === customerPrice);
  if (match && typeof match.id === "string") return match.id;
  throw new PreconditionError(
    `No subscription price point matches customerPrice ${customerPrice} in ${territory}. List price points and pass an explicit pricePointId.`,
    { subscriptionId, territory, customerPrice, availablePricePoints: data.length },
  );
};

const resolveOrVerifyPricePoint = async (
  client: AppStoreConnectClient,
  subscriptionId: string,
  territory: string,
  pricePointId: string | undefined,
  customerPrice: string | undefined,
): Promise<string> => {
  if (pricePointId === undefined && customerPrice === undefined) {
    throw new PreconditionError("Pass either pricePointId or customerPrice.", {
      subscriptionId,
      territory,
    });
  }
  if (pricePointId === undefined) {
    return resolvePricePoint(client, subscriptionId, territory, customerPrice as string);
  }

  const { data } = await client.getAll<Record<string, unknown>>(
    `/v1/subscriptions/${subscriptionId}/pricePoints`,
    { "filter[territory]": territory, limit: 200 },
  );
  if (!data.some((row) => row.id === pricePointId)) {
    throw new PreconditionError(
      `Price point ${pricePointId} does not belong to this subscription in ${territory}.`,
      { subscriptionId, territory, pricePointId },
    );
  }
  return pricePointId;
};

const inlinePrice = (
  pricePointId: string,
  territory: string,
  type:
    | "subscriptionPromotionalOfferPrices"
    | "subscriptionOfferCodePrices"
    | "winBackOfferPrices",
  localId: string,
): { relationship: { data: { type: string; id: string }[] }; included: Record<string, unknown> } => ({
  relationship: { data: [{ type, id: localId }] },
  included: {
    type,
    id: localId,
    relationships: {
      subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: pricePointId } },
      territory: { data: { type: "territories", id: territory } },
    },
  },
});

export const registerSubscriptionOfferTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_promotional_offers",
    {
      description:
        "List promotional offers on a subscription — StoreKit-referenced discounts for existing or lapsed subscribers.",
      inputSchema: { subscriptionId: subscriptionIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/subscriptions/${subscriptionId}/promotionalOffers`, {
            limit,
            "fields[subscriptionPromotionalOffers]": [
              "name",
              "offerCode",
              "duration",
              "offerMode",
              "numberOfPeriods",
            ],
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_offer_codes",
    {
      description:
        "List redeemable subscription offer-code configurations, including eligibility, duration, mode and active state.",
      inputSchema: { subscriptionId: subscriptionIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/subscriptions/${subscriptionId}/offerCodes`, {
            limit,
            "fields[subscriptionOfferCodes]": [
              "name",
              "customerEligibilities",
              "offerEligibility",
              "duration",
              "offerMode",
              "numberOfPeriods",
              "active",
            ],
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_win_back_offers",
    {
      description:
        "List win-back offers on a subscription — App Store-surfaced offers aimed at lapsed subscribers.",
      inputSchema: { subscriptionId: subscriptionIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/subscriptions/${subscriptionId}/winBackOffers`, { limit }),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_promotional_offer",
    {
      description:
        "Create a promotional offer. Apple requires an inline price even for FREE_TRIAL, so pass a valid pricePointId or a customerPrice to resolve in the chosen territory.",
      inputSchema: {
        subscriptionId: subscriptionIdArg,
        name: z.string().min(1).max(64),
        offerCode: z.string().min(1).max(64),
        offerMode: z.enum(OFFER_MODES),
        duration: z.enum(OFFER_DURATIONS),
        numberOfPeriods: z.number().int().min(1).default(1),
        territory: territoryArg.default("USA"),
        customerPrice: z.string().optional(),
        pricePointId: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({
      subscriptionId,
      name,
      offerCode,
      offerMode,
      duration,
      numberOfPeriods,
      territory,
      customerPrice,
      pricePointId,
    }) =>
      wrap(async () => {
        const pointId = await resolveOrVerifyPricePoint(
          client,
          subscriptionId,
          territory,
          pricePointId,
          customerPrice,
        );
        const price = inlinePrice(
          pointId,
          territory,
          "subscriptionPromotionalOfferPrices",
          "${promo-price-1}",
        );
        return summarizeResponse(
          await client.post("/v1/subscriptionPromotionalOffers", {
            data: {
              type: "subscriptionPromotionalOffers",
              attributes: { name, offerCode, offerMode, duration, numberOfPeriods },
              relationships: {
                subscription: { data: { type: "subscriptions", id: subscriptionId } },
                prices: price.relationship,
              },
            },
            included: [price.included],
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_add_promotional_offer_price",
    {
      description:
        "Add a discounted price in another territory to an existing promotional offer.",
      inputSchema: {
        promotionalOfferId: z.string().min(1),
        subscriptionId: subscriptionIdArg,
        territory: territoryArg,
        customerPrice: z.string().optional(),
        pricePointId: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ promotionalOfferId, subscriptionId, territory, customerPrice, pricePointId }) =>
      wrap(async () => {
        const pointId = await resolveOrVerifyPricePoint(
          client,
          subscriptionId,
          territory,
          pricePointId,
          customerPrice,
        );
        return summarizeResponse(
          await client.post("/v1/subscriptionPromotionalOfferPrices", {
            data: {
              type: "subscriptionPromotionalOfferPrices",
              relationships: {
                subscriptionPromotionalOffer: {
                  data: { type: "subscriptionPromotionalOffers", id: promotionalOfferId },
                },
                subscriptionPricePoint: {
                  data: { type: "subscriptionPricePoints", id: pointId },
                },
                territory: { data: { type: "territories", id: territory } },
              },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_create_offer_code",
    {
      description:
        "Create a subscription offer-code configuration for new, existing and/or expired subscribers. Generate redeemable custom or one-time codes afterward.",
      inputSchema: {
        subscriptionId: subscriptionIdArg,
        name: z.string().min(1).max(64),
        customerEligibilities: z.array(z.enum(ELIGIBILITIES)).min(1),
        offerEligibility: z.enum(OFFER_ELIGIBILITIES),
        offerMode: z.enum(OFFER_MODES),
        duration: z.enum(OFFER_DURATIONS),
        numberOfPeriods: z.number().int().min(1).default(1),
        territory: territoryArg.default("USA"),
        customerPrice: z.string().optional(),
        pricePointId: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({
      subscriptionId,
      name,
      customerEligibilities,
      offerEligibility,
      offerMode,
      duration,
      numberOfPeriods,
      territory,
      customerPrice,
      pricePointId,
    }) =>
      wrap(async () => {
        const pointId = await resolveOrVerifyPricePoint(
          client,
          subscriptionId,
          territory,
          pricePointId,
          customerPrice,
        );
        const price = inlinePrice(
          pointId,
          territory,
          "subscriptionOfferCodePrices",
          "${offer-code-price-1}",
        );
        return summarizeResponse(
          await client.post("/v1/subscriptionOfferCodes", {
            data: {
              type: "subscriptionOfferCodes",
              attributes: {
                name,
                customerEligibilities,
                offerEligibility,
                offerMode,
                duration,
                numberOfPeriods,
              },
              relationships: {
                subscription: { data: { type: "subscriptions", id: subscriptionId } },
                prices: price.relationship,
              },
            },
            included: [price.included],
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_create_offer_code_custom_code",
    {
      description:
        "Create one memorable redeemable code string, usable a configured number of times until its optional expiration date.",
      inputSchema: {
        offerCodeId: z.string().min(1),
        customCode: z.string().min(1).max(64),
        numberOfCodes: z.number().int().min(1),
        expirationDate: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ offerCodeId, customCode, numberOfCodes, expirationDate }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/subscriptionOfferCodeCustomCodes", {
            data: {
              type: "subscriptionOfferCodeCustomCodes",
              attributes: {
                customCode,
                numberOfCodes,
                ...(expirationDate !== undefined ? { expirationDate } : {}),
              },
              relationships: {
                offerCode: { data: { type: "subscriptionOfferCodes", id: offerCodeId } },
              },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_create_offer_code_one_time_batch",
    {
      description:
        "Ask Apple to generate a batch of unique one-time-use offer codes. The actual code strings are downloaded from App Store Connect rather than returned individually by the API.",
      inputSchema: {
        offerCodeId: z.string().min(1),
        numberOfCodes: z.number().int().min(1).max(50000),
        expirationDate: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ offerCodeId, numberOfCodes, expirationDate }) =>
      wrap(async () => ({
        batch: summarizeResponse(
          await client.post("/v1/subscriptionOfferCodeOneTimeUseCodes", {
            data: {
              type: "subscriptionOfferCodeOneTimeUseCodes",
              attributes: { numberOfCodes, expirationDate },
              relationships: {
                offerCode: { data: { type: "subscriptionOfferCodes", id: offerCodeId } },
              },
            },
          }),
        ),
        note:
          "Apple does not expose the generated code values individually through this API; download them from App Store Connect.",
      })),
  );

  server.registerTool(
    "app_store_connect_create_win_back_offer",
    {
      description:
        "Create a win-back offer for lapsed subscribers with an eligibility window, priority and discounted price.",
      inputSchema: {
        subscriptionId: subscriptionIdArg,
        referenceName: z.string().min(1).max(64),
        offerId: z.string().min(1).max(64),
        offerMode: z.enum(OFFER_MODES),
        duration: z.enum(OFFER_DURATIONS),
        periodCount: z.number().int().min(1).default(1),
        priority: z.enum(WIN_BACK_PRIORITIES),
        minimumPaidMonths: z.number().int().min(0),
        monthsSinceLastSubscribedMinimum: z.number().int().min(0),
        monthsSinceLastSubscribedMaximum: z.number().int().min(0),
        waitBetweenOffersMonths: z.number().int().min(0).optional(),
        promotionIntent: z.enum(PROMOTION_INTENTS).optional(),
        startDate: z.string().min(1),
        endDate: z.string().optional(),
        territory: territoryArg.default("USA"),
        customerPrice: z.string().optional(),
        pricePointId: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({
      subscriptionId,
      referenceName,
      offerId,
      offerMode,
      duration,
      periodCount,
      priority,
      minimumPaidMonths,
      monthsSinceLastSubscribedMinimum,
      monthsSinceLastSubscribedMaximum,
      waitBetweenOffersMonths,
      promotionIntent,
      startDate,
      endDate,
      territory,
      customerPrice,
      pricePointId,
    }) =>
      wrap(async () => {
        if (monthsSinceLastSubscribedMaximum < monthsSinceLastSubscribedMinimum) {
          throw new PreconditionError(
            "monthsSinceLastSubscribedMaximum must be greater than or equal to the minimum.",
            { monthsSinceLastSubscribedMinimum, monthsSinceLastSubscribedMaximum },
          );
        }
        const pointId = await resolveOrVerifyPricePoint(
          client,
          subscriptionId,
          territory,
          pricePointId,
          customerPrice,
        );
        const price = inlinePrice(
          pointId,
          territory,
          "winBackOfferPrices",
          "${win-back-price-1}",
        );
        const attributes: Record<string, unknown> = {
          referenceName,
          offerId,
          offerMode,
          duration,
          periodCount,
          priority,
          customerEligibilityPaidSubscriptionDurationInMonths: minimumPaidMonths,
          customerEligibilityTimeSinceLastSubscribedInMonths: {
            minimum: monthsSinceLastSubscribedMinimum,
            maximum: monthsSinceLastSubscribedMaximum,
          },
          startDate,
          ...(waitBetweenOffersMonths !== undefined
            ? { customerEligibilityWaitBetweenOffersInMonths: waitBetweenOffersMonths }
            : {}),
          ...(promotionIntent !== undefined ? { promotionIntent } : {}),
          ...(endDate !== undefined ? { endDate } : {}),
        };
        return summarizeResponse(
          await client.post("/v1/winBackOffers", {
            data: {
              type: "winBackOffers",
              attributes,
              relationships: {
                subscription: { data: { type: "subscriptions", id: subscriptionId } },
                prices: price.relationship,
              },
            },
            included: [price.included],
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_delete_promotional_offer",
    {
      description: "Permanently delete a promotional offer.",
      inputSchema: { promotionalOfferId: z.string().min(1), confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ promotionalOfferId }) =>
      wrap(async () => {
        await client.del(`/v1/subscriptionPromotionalOffers/${promotionalOfferId}`);
        return { deleted: promotionalOfferId };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_win_back_offer",
    {
      description: "Permanently delete a win-back offer.",
      inputSchema: { winBackOfferId: z.string().min(1), confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ winBackOfferId }) =>
      wrap(async () => {
        await client.del(`/v1/winBackOffers/${winBackOfferId}`);
        return { deleted: winBackOfferId };
      }),
  );
};
