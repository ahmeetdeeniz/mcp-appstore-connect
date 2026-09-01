import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { attributesOf, resourcesOf, summarizeResponse } from "../client/shape.js";
import { appIdArg, compact, confirmArg, limitArg, PreconditionError, wrap } from "./util.js";

const groupIdArg = z
  .string()
  .min(1)
  .describe("The beta group id (from app_store_connect_list_beta_groups).");

const testerIdArg = z
  .string()
  .min(1)
  .describe("The beta tester id (from app_store_connect_list_beta_testers).");

const buildIdArg = z
  .string()
  .min(1)
  .describe("The build resource id from app_store_connect_list_builds.");

const betaLocalizationForLocale = async (
  client: AppStoreConnectClient,
  buildId: string,
  locale: string,
): Promise<Record<string, unknown> | undefined> => {
  const response = await client.get(`/v1/builds/${buildId}/betaBuildLocalizations`, {
    "filter[locale]": locale,
    limit: 50,
  });
  return resourcesOf(response).find((row) => attributesOf(row).locale === locale);
};

export const registerTestflightTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_beta_groups",
    {
      description:
        "List an app's TestFlight beta groups (internal and external), with their public-link " +
        "state. Returns the group ids used to manage testers and distribute builds.",
      inputSchema: { appId: appIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get("/v1/betaGroups", compact({ "filter[app]": appId, limit })),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_beta_testers",
    {
      description:
        "List TestFlight beta testers. Scope to one group with `groupId`, or search all testers " +
        "by email. Returns each tester's id, email, name and invite state.",
      inputSchema: {
        groupId: z.string().optional().describe("Only testers in this beta group."),
        email: z.string().optional().describe("Filter by tester email."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ groupId, email, limit }) =>
      wrap(async () =>
        summarizeResponse(
          groupId
            ? await client.get(`/v1/betaGroups/${groupId}/betaTesters`, compact({ limit }))
            : await client.get("/v1/betaTesters", compact({ "filter[email]": email, limit })),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_beta_feedback",
    {
      description:
        "List TestFlight beta feedback screenshot submissions for an app (tester comment, device " +
        "model, OS version, and screenshot asset links).",
      inputSchema: { appId: appIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/betaFeedbackScreenshotSubmissions`,
            compact({ limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_beta_build_localizations",
    {
      description:
        "List a TestFlight build's localized What to Test text. This copy is independent from the " +
        "App Store version's What's New field and is what beta testers see in TestFlight.",
      inputSchema: { buildId: buildIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ buildId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/builds/${buildId}/betaBuildLocalizations`, { limit }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_build_beta_groups",
    {
      description:
        "List the TestFlight beta groups a build is currently distributed to. Use this before or " +
        "after distribution to see exactly which internal/external audiences can install it.",
      inputSchema: { buildId: buildIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ buildId, limit }) =>
      wrap(async () =>
        summarizeResponse(await client.get(`/v1/builds/${buildId}/betaGroups`, { limit })),
      ),
  );

  server.registerTool(
    "app_store_connect_list_beta_review_submissions",
    {
      description:
        "List Beta App Review submissions for a build. External TestFlight distribution requires " +
        "Apple's beta review; this shows whether the build has already been submitted and its state.",
      inputSchema: { buildId: buildIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ buildId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get("/v1/betaAppReviewSubmissions", {
            "filter[build]": buildId,
            limit,
          }),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_beta_group",
    {
      description:
        "Create a TestFlight beta group for an app — the container builds are distributed " +
        "through. An app with no group has nowhere to send a build, so this is the first step " +
        "of setting up TestFlight; every other beta tool needs the group id it returns. " +
        "Internal groups take testers who are already Users on the App Store Connect account " +
        "(up to 100) and receive builds without Beta App Review, which makes " +
        "`hasAccessToAllBuilds` the quickest way to make existing builds installable. External " +
        "groups take anyone by email, and their first build needs review.",
      inputSchema: {
        appId: appIdArg,
        name: z
          .string()
          .min(1)
          .describe('Group name, unique within the app, e.g. "Internal" or "Public Beta".'),
        isInternalGroup: z
          .boolean()
          .default(true)
          .describe(
            "True for an internal group (testers must be account Users; no Beta App Review). " +
              "False for an external group.",
          ),
        hasAccessToAllBuilds: z
          .boolean()
          .optional()
          .describe(
            "Internal groups only. Give the group every build automatically, including ones " +
              "already uploaded, instead of assigning builds one at a time.",
          ),
        publicLinkEnabled: z
          .boolean()
          .optional()
          .describe("External groups only. Enable a public TestFlight invite link."),
        publicLinkLimit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("External groups only. Cap how many testers the public link admits."),
        feedbackEnabled: z
          .boolean()
          .optional()
          .describe("Let testers send feedback and screenshots from the TestFlight app."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({
      appId,
      name,
      isInternalGroup,
      hasAccessToAllBuilds,
      publicLinkEnabled,
      publicLinkLimit,
      feedbackEnabled,
    }) =>
      wrap(async () => {
        if (isInternalGroup && (publicLinkEnabled !== undefined || publicLinkLimit !== undefined)) {
          throw new PreconditionError("Public links are only available on external beta groups.", {
            isInternalGroup,
            publicLinkEnabled,
            publicLinkLimit,
          });
        }
        if (!isInternalGroup && hasAccessToAllBuilds !== undefined) {
          throw new PreconditionError(
            "hasAccessToAllBuilds is only available on internal beta groups.",
            { isInternalGroup, hasAccessToAllBuilds },
          );
        }
        return summarizeResponse(
          await client.post("/v1/betaGroups", {
            data: {
              type: "betaGroups",
              attributes: compact({
                name,
                isInternalGroup,
                hasAccessToAllBuilds,
                publicLinkEnabled,
                publicLinkLimit,
                feedbackEnabled,
              }),
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_set_beta_whats_new",
    {
      description:
        "Upsert the localized What to Test text for a TestFlight build. Existing locales are PATCHed " +
        "and missing ones are created. Apple's 4000-character limit is enforced locally.",
      inputSchema: {
        buildId: buildIdArg,
        locale: z.string().min(2),
        whatsNew: z.string().max(4000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ buildId, locale, whatsNew }) =>
      wrap(async () => {
        const existing = await betaLocalizationForLocale(client, buildId, locale);
        if (existing !== undefined && typeof existing.id === "string") {
          return summarizeResponse(
            await client.patch(`/v1/betaBuildLocalizations/${existing.id}`, {
              data: {
                type: "betaBuildLocalizations",
                id: existing.id,
                attributes: { whatsNew },
              },
            }),
          );
        }
        return summarizeResponse(
          await client.post("/v1/betaBuildLocalizations", {
            data: {
              type: "betaBuildLocalizations",
              attributes: { locale, whatsNew },
              relationships: { build: { data: { type: "builds", id: buildId } } },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_distribute_build_to_beta_groups",
    {
      description:
        "Distribute one TestFlight build to one or more beta groups. The tool first reads the build's " +
        "existing groups and only adds missing relationships, so retrying it after a partial failure is safe.",
      inputSchema: {
        buildId: buildIdArg,
        groupIds: z.array(groupIdArg).min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ buildId, groupIds }) =>
      wrap(async () => {
        const current = resourcesOf(
          await client.get(`/v1/builds/${buildId}/betaGroups`, { limit: 200 }),
        );
        const existing = new Set(
          current.map((row) => row.id).filter((id): id is string => typeof id === "string"),
        );
        const added: string[] = [];
        const alreadyPresent: string[] = [];
        for (const groupId of new Set(groupIds)) {
          if (existing.has(groupId)) {
            alreadyPresent.push(groupId);
            continue;
          }
          await client.post(`/v1/betaGroups/${groupId}/relationships/builds`, {
            data: [{ type: "builds", id: buildId }],
          });
          added.push(groupId);
        }
        return { buildId, added, alreadyPresent };
      }),
  );

  server.registerTool(
    "app_store_connect_remove_build_from_beta_group",
    {
      description:
        "Remove a TestFlight build from a beta group. Testers in that group lose access to this build. " +
        "This changes distribution state and requires confirm: true.",
      inputSchema: { buildId: buildIdArg, groupId: groupIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ buildId, groupId }) =>
      wrap(async () => {
        await client.del(`/v1/betaGroups/${groupId}/relationships/builds`, {
          data: [{ type: "builds", id: buildId }],
        });
        return { buildId, removedFromGroup: groupId };
      }),
  );

  server.registerTool(
    "app_store_connect_submit_build_for_beta_review",
    {
      description:
        "Submit a TestFlight build for Beta App Review, which is required before external testers can " +
        "receive it. This hands the build to Apple, so it requires confirm: true. The tool refuses a " +
        "duplicate submission when one already exists for the build.",
      inputSchema: { buildId: buildIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ buildId }) =>
      wrap(async () => {
        const existing = resourcesOf(
          await client.get("/v1/betaAppReviewSubmissions", {
            "filter[build]": buildId,
            limit: 50,
          }),
        );
        if (existing.length > 0) {
          throw new PreconditionError(
            "This build already has a Beta App Review submission. Read its state instead of submitting a duplicate.",
            {
              buildId,
              submissions: existing.map((row) => ({ id: row.id, ...attributesOf(row) })),
            },
          );
        }
        return summarizeResponse(
          await client.post("/v1/betaAppReviewSubmissions", {
            data: {
              type: "betaAppReviewSubmissions",
              relationships: { build: { data: { type: "builds", id: buildId } } },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_invite_beta_tester",
    {
      description:
        "Invite a new external TestFlight tester by email into a beta group. Sends them an " +
        "invitation. Use app_store_connect_add_tester_to_group for a tester that already exists.",
      inputSchema: {
        groupId: groupIdArg,
        email: z.string().min(1).describe("The tester's email address."),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ groupId, email, firstName, lastName }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/betaTesters", {
            data: {
              type: "betaTesters",
              attributes: compact({ email, firstName, lastName }),
              relationships: { betaGroups: { data: [{ type: "betaGroups", id: groupId }] } },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_add_tester_to_group",
    {
      description: "Add an existing beta tester to a beta group.",
      inputSchema: { groupId: groupIdArg, testerId: testerIdArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ groupId, testerId }) =>
      wrap(async () => {
        await client.post(`/v1/betaGroups/${groupId}/relationships/betaTesters`, {
          data: [{ type: "betaTesters", id: testerId }],
        });
        return { added: testerId, groupId };
      }),
  );

  server.registerTool(
    "app_store_connect_remove_tester_from_group",
    {
      description:
        "Remove a beta tester from a beta group. They lose access to that group's builds.",
      inputSchema: { groupId: groupIdArg, testerId: testerIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ groupId, testerId }) =>
      wrap(async () => {
        await client.del(`/v1/betaGroups/${groupId}/relationships/betaTesters`, {
          data: [{ type: "betaTesters", id: testerId }],
        });
        return { removed: testerId, groupId };
      }),
  );
};
