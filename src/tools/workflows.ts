import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { resourcesOf } from "../client/shape.js";
import { appIdArg, wrap } from "./util.js";

const rows = (response: unknown): Array<Record<string, unknown>> =>
  resourcesOf(response).map((row) => ({
    id: row.id,
    ...(typeof row.attributes === "object" && row.attributes !== null
      ? (row.attributes as Record<string, unknown>)
      : {}),
  }));

export const registerWorkflowTools = (
  server: McpServer,
  client: AppStoreConnectClient,
): void => {
  server.registerTool(
    "app_store_connect_prepare_release_plan",
    {
      description:
        "Build a compact, read-only release plan for an app without changing App Store Connect. It identifies the editable version, recent builds, TestFlight groups and common manual/typed next steps so an agent can decide what to do next safely.",
      inputSchema: {
        appId: appIdArg,
        platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, platform }) =>
      wrap(async () => {
        const [versionsResult, buildsResult, groupsResult, reviewsResult] = await Promise.allSettled([
          client.get(`/v1/apps/${appId}/appStoreVersions`, {
            "filter[platform]": platform,
            limit: 10,
            sort: "-createdDate",
          }),
          client.get("/v1/builds", { "filter[app]": appId, limit: 10, sort: "-uploadedDate" }),
          client.get("/v1/betaGroups", { "filter[app]": appId, limit: 50 }),
          client.get(`/v1/apps/${appId}/customerReviews`, {
            "exists[publishedResponse]": false,
            sort: "-createdDate",
            limit: 10,
          }),
        ]);

        const versions = versionsResult.status === "fulfilled" ? rows(versionsResult.value) : [];
        const builds = buildsResult.status === "fulfilled" ? rows(buildsResult.value) : [];
        const betaGroups = groupsResult.status === "fulfilled" ? rows(groupsResult.value) : [];
        const unansweredReviews = reviewsResult.status === "fulfilled" ? rows(reviewsResult.value) : [];
        const editableVersion = versions.find((v) =>
          ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"].includes(
            String(v.appStoreState ?? v.state ?? ""),
          ),
        );

        return {
          appId,
          platform,
          editableVersion: editableVersion ?? null,
          recentBuilds: builds,
          betaGroups,
          unansweredReviews,
          suggestedSequence: [
            "run app_store_connect_release_doctor on the target version",
            "attach/select the intended processed build",
            "sync listing/localizations and screenshots",
            "verify pricing, category, content rights and App Review contact",
            "complete App Privacy manually in App Store Connect if required",
            "submit only after explicit user confirmation",
          ],
          mutationPerformed: false,
        };
      }),
  );

  server.registerTool(
    "app_store_connect_review_inbox",
    {
      description:
        "Return a compact unanswered customer-review inbox for an agent to triage and draft responses. This never publishes a response; publishing uses the separately confirmed response tool.",
      inputSchema: {
        appId: appIdArg,
        maxRating: z.number().int().min(1).max(5).default(3),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, maxRating, limit }) =>
      wrap(async () => {
        const rating = Array.from({ length: maxRating }, (_, i) => String(i + 1));
        const response = await client.get(`/v1/apps/${appId}/customerReviews`, {
          "filter[rating]": rating,
          "exists[publishedResponse]": false,
          sort: "-createdDate",
          limit,
        });
        return {
          appId,
          maxRating,
          reviews: rows(response),
          nextStep:
            "Draft responses first; publish only with app_store_connect_respond_to_customer_review and explicit confirm:true.",
        };
      }),
  );
};
