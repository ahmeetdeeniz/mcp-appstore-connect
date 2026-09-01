import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { attributesOf, resourcesOf, summarizeResponse } from "../client/shape.js";
import { appIdArg, compact, confirmArg, limitArg, wrap } from "./util.js";

const EVENT_BADGES = [
  "LIVE_EVENT",
  "PREMIERE",
  "CHALLENGE",
  "COMPETITION",
  "NEW_SEASON",
  "MAJOR_UPDATE",
  "SPECIAL_EVENT",
] as const;
const EVENT_PRIORITIES = ["HIGH", "NORMAL"] as const;
const EVENT_PURPOSES = [
  "APPROPRIATE_FOR_ALL_USERS",
  "ATTRACT_NEW_USERS",
  "KEEP_ACTIVE_USERS_INFORMED",
  "BRING_BACK_LAPSED_USERS",
] as const;

const appEventIdArg = z.string().min(1).describe("The appEvent id.");
const territorySchedule = z.object({
  territories: z.array(z.string().length(3)).min(1),
  publishStart: z.string().min(1).describe("ISO-8601 date-time when the event becomes visible."),
  eventStart: z.string().min(1).describe("ISO-8601 date-time when the event starts."),
  eventEnd: z.string().min(1).describe("ISO-8601 date-time when the event ends."),
});

const assertChronology = (
  schedules: { publishStart: string; eventStart: string; eventEnd: string }[] | undefined,
): void => {
  for (const [index, schedule] of (schedules ?? []).entries()) {
    const publish = Date.parse(schedule.publishStart);
    const start = Date.parse(schedule.eventStart);
    const end = Date.parse(schedule.eventEnd);
    if ([publish, start, end].some(Number.isNaN)) {
      throw new Error(`territorySchedules[${index}] contains an invalid ISO-8601 date-time.`);
    }
    if (start > end) {
      throw new Error(`territorySchedules[${index}] has eventStart after eventEnd.`);
    }
    if (publish > end) {
      throw new Error(`territorySchedules[${index}] has publishStart after eventEnd.`);
    }
  }
};

export const registerAppEventTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_app_events",
    {
      description:
        "List an app's In-App Events — time-boxed events Apple can surface on the product page, search and Today.",
      inputSchema: { appId: appIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/apps/${appId}/appEvents`, {
            limit,
            "fields[appEvents]": [
              "referenceName",
              "badge",
              "eventState",
              "priority",
              "purpose",
              "deepLink",
              "primaryLocale",
            ],
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_app_event",
    {
      description:
        "Get one In-App Event plus its customer-facing localizations. Asset upload is intentionally separate from this metadata workflow.",
      inputSchema: { appEventId: appEventIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appEventId }) =>
      wrap(async () => {
        const event = await client.get(`/v1/appEvents/${appEventId}`);
        const localizations = await client.get(`/v1/appEvents/${appEventId}/localizations`, {
          limit: 200,
        });
        return {
          event: summarizeResponse(event),
          localizations: summarizeResponse(localizations),
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_app_event",
    {
      description:
        "Create an In-App Event. Set localized copy and territory schedules before review. This does not submit anything to Apple Review.",
      inputSchema: {
        appId: appIdArg,
        referenceName: z.string().min(1).max(64),
        badge: z.enum(EVENT_BADGES).optional(),
        priority: z.enum(EVENT_PRIORITIES).optional(),
        purpose: z.enum(EVENT_PURPOSES).optional(),
        primaryLocale: z.string().optional(),
        deepLink: z.string().optional(),
        purchaseRequirement: z.string().optional(),
        territorySchedules: z.array(territorySchedule).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appId, referenceName, territorySchedules, ...rest }) =>
      wrap(async () => {
        assertChronology(territorySchedules);
        return summarizeResponse(
          await client.post("/v1/appEvents", {
            data: {
              type: "appEvents",
              attributes: compact({ referenceName, ...rest, territorySchedules }),
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_update_app_event",
    {
      description:
        "Update an In-App Event's badge, priority, purpose, deep link, purchase requirement or territory schedule. Only passed fields change.",
      inputSchema: {
        appEventId: appEventIdArg,
        badge: z.enum(EVENT_BADGES).optional(),
        priority: z.enum(EVENT_PRIORITIES).optional(),
        purpose: z.enum(EVENT_PURPOSES).optional(),
        deepLink: z.string().optional(),
        purchaseRequirement: z.string().optional(),
        territorySchedules: z.array(territorySchedule).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ appEventId, territorySchedules, ...rest }) =>
      wrap(async () => {
        assertChronology(territorySchedules);
        const attributes = compact({ ...rest, territorySchedules });
        if (Object.keys(attributes).length === 0) {
          throw new Error("Pass at least one event field to update.");
        }
        return summarizeResponse(
          await client.patch(`/v1/appEvents/${appEventId}`, {
            data: { type: "appEvents", id: appEventId, attributes },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_set_app_event_localization",
    {
      description:
        "Upsert one locale's In-App Event name, short description and long description. Name is required when creating a new locale.",
      inputSchema: {
        appEventId: appEventIdArg,
        locale: z.string().min(2),
        name: z.string().max(30).optional(),
        shortDescription: z.string().max(50).optional(),
        longDescription: z.string().max(120).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ appEventId, locale, name, shortDescription, longDescription }) =>
      wrap(async () => {
        const existing = resourcesOf(
          await client.get(`/v1/appEvents/${appEventId}/localizations`, {
            limit: 200,
            "fields[appEventLocalizations]": ["locale"],
          }),
        );
        const match = existing.find((row) => attributesOf(row).locale === locale);
        const attributes = compact({ name, shortDescription, longDescription });
        if (match && typeof match.id === "string") {
          return summarizeResponse(
            await client.patch(`/v1/appEventLocalizations/${match.id}`, {
              data: { type: "appEventLocalizations", id: match.id, attributes },
            }),
          );
        }
        if (name === undefined || name.trim() === "") {
          throw new Error("name is required when creating a new In-App Event localization.");
        }
        return summarizeResponse(
          await client.post("/v1/appEventLocalizations", {
            data: {
              type: "appEventLocalizations",
              attributes: { locale, ...attributes },
              relationships: { appEvent: { data: { type: "appEvents", id: appEventId } } },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_delete_app_event",
    {
      description: "Permanently delete an In-App Event.",
      inputSchema: { appEventId: appEventIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ appEventId }) =>
      wrap(async () => {
        await client.del(`/v1/appEvents/${appEventId}`);
        return { deleted: appEventId };
      }),
  );
};
