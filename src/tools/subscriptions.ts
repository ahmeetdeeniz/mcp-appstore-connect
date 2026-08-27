import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { attributesOf, resourceOf, resourcesOf, summarizeResponse } from "../client/shape.js";
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

const SUBSCRIPTION_PERIODS = [
  "ONE_WEEK",
  "ONE_MONTH",
  "TWO_MONTHS",
  "THREE_MONTHS",
  "SIX_MONTHS",
  "ONE_YEAR",
] as const;

const subscriptionGroupIdArg = z
  .string()
  .min(1)
  .describe("The subscriptionGroup id returned by app_store_connect_list_subscription_groups.");

const subscriptionIdArg = z
  .string()
  .min(1)
  .describe("The subscription resource id, not the StoreKit productId string.");

const localeArg = z.string().min(2).describe('App Store locale, e.g. "en-US", "tr", "de-DE".');

const assertSubscriptionCopyLimits = (fields: { name?: string; description?: string }): void => {
  const limits = { name: 30, description: 45 } as const;
  for (const [field, limit] of Object.entries(limits)) {
    const value = fields[field as keyof typeof limits];
    if (value === undefined || value.length <= limit) continue;
    throw new PreconditionError(
      `The subscription ${field} is ${value.length} characters, over Apple's ${limit}-character limit.`,
      { field, length: value.length, limit },
    );
  }
};

const localizationByLocale = async (
  client: AppStoreConnectClient,
  path: string,
  locale: string,
): Promise<Record<string, unknown> | undefined> => {
  const response = await client.get(path, { "filter[locale]": locale, limit: 50 });
  return resourcesOf(response).find((row) => attributesOf(row).locale === locale);
};

const assertSubscriptionPricePointBelongs = async (
  client: AppStoreConnectClient,
  subscriptionId: string,
  pricePointId: string,
  territory: string,
): Promise<Record<string, unknown>> => {
  const { data } = await client.getAll<Record<string, unknown>>(
    `/v1/subscriptions/${subscriptionId}/pricePoints`,
    { "filter[territory]": territory, limit: 200 },
  );
  const match = data.find((row) => row.id === pricePointId);
  if (match !== undefined) return attributesOf(match);
  throw new PreconditionError(
    `Price point ${pricePointId} is not one of subscription ${subscriptionId}'s ${territory} price points.`,
    { subscriptionId, pricePointId, territory, availablePricePoints: data.length },
  );
};

export const registerSubscriptionTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_subscription_groups",
    {
      description:
        "List an app's auto-renewable subscription groups, with their subscriptions sideloaded. " +
        "A customer can hold only one active subscription per group, so tiers that upgrade or downgrade " +
        "one another normally belong in the same group.",
      inputSchema: { appId: appIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/apps/${appId}/subscriptionGroups`, {
            include: "subscriptions",
            "fields[subscriptionGroups]": ["referenceName", "subscriptions"],
            "fields[subscriptions]": [
              "name",
              "productId",
              "subscriptionPeriod",
              "state",
              "groupLevel",
            ],
            "limit[subscriptions]": 50,
            limit,
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_subscriptions",
    {
      description:
        "List the subscriptions inside one subscription group. Returns each resource id, productId, " +
        "billing period, review state and groupLevel.",
      inputSchema: { subscriptionGroupId: subscriptionGroupIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionGroupId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/subscriptionGroups/${subscriptionGroupId}/subscriptions`, {
            limit,
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_subscription",
    {
      description:
        "Get one auto-renewable subscription's attributes. Use the companion localization, " +
        "availability and price-point tools for the customer-facing release setup.",
      inputSchema: { subscriptionId: subscriptionIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId }) =>
      wrap(async () => summarizeResponse(await client.get(`/v1/subscriptions/${subscriptionId}`))),
  );

  server.registerTool(
    "app_store_connect_list_subscription_group_localizations",
    {
      description: "List the customer-facing localized names configured for a subscription group.",
      inputSchema: { subscriptionGroupId: subscriptionGroupIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionGroupId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/subscriptionGroups/${subscriptionGroupId}/subscriptionGroupLocalizations`,
            { limit },
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_subscription_localizations",
    {
      description:
        "List a subscription's customer-facing display name and description for every locale. " +
        "A missing localization is a common reason a new subscription is not ready for review.",
      inputSchema: { subscriptionId: subscriptionIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/subscriptions/${subscriptionId}/subscriptionLocalizations`, {
            limit,
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_subscription_price_points",
    {
      description:
        "List Apple's valid price points for a subscription in one territory. The returned id is " +
        "what app_store_connect_set_subscription_price takes; customerPrice and proceeds are shown " +
        "so callers do not have to decode opaque price-point ids.",
      inputSchema: {
        subscriptionId: subscriptionIdArg,
        territory: territoryArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, territory, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/subscriptions/${subscriptionId}/pricePoints`, {
            "filter[territory]": territory,
            limit,
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_subscription_availability",
    {
      description:
        "Get a subscription's territory availability. A null result means no availability resource " +
        "has been configured yet, which must be fixed before pricing a new subscription.",
      inputSchema: { subscriptionId: subscriptionIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId }) =>
      wrap(async () => {
        const response = await getOrNull(
          client,
          `/v1/subscriptions/${subscriptionId}/subscriptionAvailability`,
          { include: "availableTerritories" },
        );
        return response === null
          ? {
              data: null,
              note:
                "No subscription availability is configured. Set territories before setting the initial price.",
            }
          : summarizeResponse(response);
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_subscription_group",
    {
      description:
        "Create an auto-renewable subscription group. referenceName is internal; add the customer-facing " +
        "name per locale with app_store_connect_set_subscription_group_localization.",
      inputSchema: {
        appId: appIdArg,
        referenceName: z.string().min(1).max(64).describe("Internal group name in App Store Connect."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appId, referenceName }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/subscriptionGroups", {
            data: {
              type: "subscriptionGroups",
              attributes: { referenceName },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_create_subscription",
    {
      description:
        "Create an auto-renewable subscription inside a group. productId is the immutable StoreKit " +
        "identifier; groupLevel ranks upgrade/downgrade tiers with 1 as the highest service level.",
      inputSchema: {
        subscriptionGroupId: subscriptionGroupIdArg,
        name: z.string().min(1).max(64).describe("Internal reference name."),
        productId: z.string().min(1).describe("StoreKit product id, e.g. com.acme.pro.monthly."),
        subscriptionPeriod: z.enum(SUBSCRIPTION_PERIODS),
        groupLevel: z.number().int().min(1).optional(),
        familySharable: z.boolean().optional(),
        reviewNote: z.string().max(4000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({
      subscriptionGroupId,
      name,
      productId,
      subscriptionPeriod,
      groupLevel,
      familySharable,
      reviewNote,
    }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/subscriptions", {
            data: {
              type: "subscriptions",
              attributes: compact({
                name,
                productId,
                subscriptionPeriod,
                groupLevel,
                familySharable,
                reviewNote,
              }),
              relationships: {
                group: { data: { type: "subscriptionGroups", id: subscriptionGroupId } },
              },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_set_subscription_group_localization",
    {
      description:
        "Upsert a subscription group's customer-facing name for one locale. Existing locales are PATCHed; " +
        "missing locales are created. name is required only when the locale does not exist yet.",
      inputSchema: {
        subscriptionGroupId: subscriptionGroupIdArg,
        locale: localeArg,
        name: z.string().min(1).optional(),
        customAppName: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ subscriptionGroupId, locale, name, customAppName }) =>
      wrap(async () => {
        const path = `/v1/subscriptionGroups/${subscriptionGroupId}/subscriptionGroupLocalizations`;
        const existing = await localizationByLocale(client, path, locale);
        const attributes = compact({ name, customAppName });
        if (existing !== undefined && typeof existing.id === "string") {
          return summarizeResponse(
            await client.patch(`/v1/subscriptionGroupLocalizations/${existing.id}`, {
              data: {
                type: "subscriptionGroupLocalizations",
                id: existing.id,
                attributes,
              },
            }),
          );
        }
        if (name === undefined) {
          throw new PreconditionError(
            `Subscription group locale ${locale} does not exist yet, so name is required to create it.`,
            { subscriptionGroupId, locale },
          );
        }
        return summarizeResponse(
          await client.post("/v1/subscriptionGroupLocalizations", {
            data: {
              type: "subscriptionGroupLocalizations",
              attributes: { locale, ...attributes },
              relationships: {
                subscriptionGroup: {
                  data: { type: "subscriptionGroups", id: subscriptionGroupId },
                },
              },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_set_subscription_localization",
    {
      description:
        "Upsert one subscription localization. The display name is limited to 30 UTF-16 code units " +
        "and the description to 45; the tool checks both before Apple can reject them opaquely.",
      inputSchema: {
        subscriptionId: subscriptionIdArg,
        locale: localeArg,
        name: z.string().min(1).optional(),
        description: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ subscriptionId, locale, name, description }) =>
      wrap(async () => {
        assertSubscriptionCopyLimits({ name, description });
        const path = `/v1/subscriptions/${subscriptionId}/subscriptionLocalizations`;
        const existing = await localizationByLocale(client, path, locale);
        const attributes = compact({ name, description });
        if (existing !== undefined && typeof existing.id === "string") {
          return summarizeResponse(
            await client.patch(`/v1/subscriptionLocalizations/${existing.id}`, {
              data: {
                type: "subscriptionLocalizations",
                id: existing.id,
                attributes,
              },
            }),
          );
        }
        if (name === undefined) {
          throw new PreconditionError(
            `Subscription locale ${locale} does not exist yet, so name is required to create it.`,
            { subscriptionId, locale },
          );
        }
        return summarizeResponse(
          await client.post("/v1/subscriptionLocalizations", {
            data: {
              type: "subscriptionLocalizations",
              attributes: { locale, ...attributes },
              relationships: {
                subscription: { data: { type: "subscriptions", id: subscriptionId } },
              },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_set_subscription_availability",
    {
      description:
        "Set or replace the territories where a subscription is available. Existing availability is PATCHed " +
        "rather than creating a duplicate. Pass territory codes directly, or availableInAllTerritories=true " +
        "to resolve Apple's current territory catalogue first.",
      inputSchema: {
        subscriptionId: subscriptionIdArg,
        territories: z.array(z.string().length(3)).optional(),
        availableInAllTerritories: z.boolean().default(false),
        availableInNewTerritories: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({
      subscriptionId,
      territories,
      availableInAllTerritories = false,
      availableInNewTerritories = true,
    }) =>
      wrap(async () => {
        let territoryIds = territories;
        if (availableInAllTerritories) {
          const all = await client.getAll<Record<string, unknown>>("/v1/territories", { limit: 200 });
          territoryIds = all.data
            .map((row) => row.id)
            .filter((id): id is string => typeof id === "string");
        }
        if (!territoryIds || territoryIds.length === 0) {
          throw new PreconditionError(
            "Provide at least one territory or set availableInAllTerritories=true.",
            { subscriptionId },
          );
        }

        const relationship = {
          availableTerritories: {
            data: territoryIds.map((id) => ({ type: "territories", id })),
          },
        };
        const current = await getOrNull(
          client,
          `/v1/subscriptions/${subscriptionId}/subscriptionAvailability`,
        );
        const currentId = resourceOf(current).id;
        if (typeof currentId === "string") {
          return summarizeResponse(
            await client.patch(`/v1/subscriptionAvailabilities/${currentId}`, {
              data: {
                type: "subscriptionAvailabilities",
                id: currentId,
                attributes: { availableInNewTerritories },
                relationships: relationship,
              },
            }),
          );
        }
        return summarizeResponse(
          await client.post("/v1/subscriptionAvailabilities", {
            data: {
              type: "subscriptionAvailabilities",
              attributes: { availableInNewTerritories },
              relationships: {
                subscription: { data: { type: "subscriptions", id: subscriptionId } },
                ...relationship,
              },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_set_subscription_price",
    {
      description:
        "Create a subscription price from one of Apple's price points. Availability should be configured first. " +
        "The tool verifies that the pricePointId belongs to this subscription and base territory before writing, " +
        "because Apple otherwise accepts an opaque id whose amount is easy to misread.",
      inputSchema: {
        subscriptionId: subscriptionIdArg,
        baseTerritory: territoryArg,
        pricePointId: z.string().min(1),
        preserveCurrentPrice: z.boolean().optional(),
        startDate: z.string().optional().describe("ISO-8601 date/time; omit for immediate."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ subscriptionId, baseTerritory, pricePointId, preserveCurrentPrice, startDate }) =>
      wrap(async () => {
        const availability = await getOrNull(
          client,
          `/v1/subscriptions/${subscriptionId}/subscriptionAvailability`,
        );
        if (resourceOf(availability).id === undefined) {
          throw new PreconditionError(
            "Set subscription availability before setting the initial price. Apple rejects pricing an unavailable subscription with an opaque 409.",
            { subscriptionId },
          );
        }
        const pricePoint = await assertSubscriptionPricePointBelongs(
          client,
          subscriptionId,
          pricePointId,
          baseTerritory,
        );
        return {
          pricePoint: { id: pricePointId, ...pricePoint },
          result: summarizeResponse(
            await client.post("/v1/subscriptionPrices", {
              data: {
                type: "subscriptionPrices",
                attributes: compact({ preserveCurrentPrice, startDate }),
                relationships: {
                  subscription: { data: { type: "subscriptions", id: subscriptionId } },
                  subscriptionPricePoint: {
                    data: { type: "subscriptionPricePoints", id: pricePointId },
                  },
                },
              },
            }),
          ),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_subscription",
    {
      description:
        "Permanently delete an editable subscription. Apple refuses deletion after the product is approved. " +
        "This cannot be undone and therefore requires confirm: true.",
      inputSchema: { subscriptionId: subscriptionIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ subscriptionId }) =>
      wrap(async () => {
        await client.del(`/v1/subscriptions/${subscriptionId}`);
        return { deleted: subscriptionId };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_subscription_group",
    {
      description:
        "Permanently delete an empty subscription group. Delete its subscriptions first. This cannot be " +
        "undone and therefore requires confirm: true.",
      inputSchema: { subscriptionGroupId: subscriptionGroupIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ subscriptionGroupId }) =>
      wrap(async () => {
        await client.del(`/v1/subscriptionGroups/${subscriptionGroupId}`);
        return { deleted: subscriptionGroupId };
      }),
  );
};
