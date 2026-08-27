import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { resourcesOf } from "../client/shape.js";
import { appIdArg, wrap } from "./util.js";

const compactRows = (response: unknown): unknown[] =>
  resourcesOf(response).map((row) => ({
    id: row.id,
    ...(typeof row.attributes === "object" && row.attributes !== null
      ? (row.attributes as Record<string, unknown>)
      : {}),
  }));

export const registerOperatorTools = (
  server: McpServer,
  client: AppStoreConnectClient,
): void => {
  server.registerTool(
    "app_store_connect_operator_capabilities",
    {
      description:
        "Describe this fork's safety model and high-level capability areas for any MCP client (Claude Code, Codex, ChatGPT, Cursor, or another MCP host). Use this first when an agent needs to understand what it may safely automate.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => ({
        clientAgnostic: true,
        transport: "MCP stdio",
        safety: {
          writesHiddenByDefault: true,
          writeGate: "APP_STORE_CONNECT_ALLOW_WRITES=1",
          rawWriteSecondGate: "APP_STORE_CONNECT_ALLOW_RAW_WRITES=1",
          destructiveCallsRequireConfirm: true,
          listingApplyDefaultsToDryRun: true,
        },
        capabilities: {
          release: [
            "release doctor",
            "versions",
            "build attachment",
            "metadata/localizations",
            "screenshots",
            "review submission",
            "manual release",
          ],
          testflight: [
            "groups",
            "testers",
            "what-to-test localizations",
            "idempotent build distribution",
            "Beta App Review",
          ],
          commerce: [
            "in-app purchases",
            "auto-renewable subscriptions",
            "subscription pricing/availability",
            "promotional offers",
            "offer codes",
            "win-back offers",
          ],
          marketing: [
            "Custom Product Pages",
            "Custom Product Page screenshots",
            "In-App Events",
            "In-App Event images",
          ],
          observability: ["customer reviews", "analytics", "sales reports", "finance reports"],
          escapeHatch: ["guarded raw GET", "double-gated raw mutation"],
        },
        knownManualGate:
          "App Privacy questionnaire is not reliably exposed by Apple's public App Store Connect API and remains a manual web step.",
      })),
  );

  server.registerTool(
    "app_store_connect_operator_snapshot",
    {
      description:
        "Get one compact, read-only operating snapshot of an app for an AI agent: editable/recent versions, recent builds, TestFlight groups, subscription groups, Custom Product Pages and In-App Events. This is a context-efficient starting point before choosing typed tools.",
      inputSchema: {
        appId: appIdArg,
        platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, platform }) =>
      wrap(async () => {
        const results = await Promise.allSettled([
          client.get(`/v1/apps/${appId}/appStoreVersions`, {
            "filter[platform]": platform,
            limit: 10,
          }),
          client.get("/v1/builds", { "filter[app]": appId, limit: 10 }),
          client.get("/v1/betaGroups", { "filter[app]": appId, limit: 50 }),
          client.get(`/v1/apps/${appId}/subscriptionGroups`, { limit: 50 }),
          client.get(`/v1/apps/${appId}/appCustomProductPages`, { limit: 50 }),
          client.get(`/v1/apps/${appId}/appEvents`, { limit: 50 }),
        ]);

        const names = [
          "versions",
          "builds",
          "betaGroups",
          "subscriptionGroups",
          "customProductPages",
          "appEvents",
        ] as const;
        const snapshot: Record<string, unknown> = { appId, platform };
        const unavailable: Record<string, string> = {};

        results.forEach((result, index) => {
          const name = names[index] as string;
          if (result.status === "fulfilled") snapshot[name] = compactRows(result.value);
          else unavailable[name] = result.reason instanceof Error ? result.reason.message : String(result.reason);
        });
        if (Object.keys(unavailable).length > 0) snapshot.unavailable = unavailable;
        return snapshot;
      }),
  );
};
