import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { isRecord, resourceOf } from "../client/shape.js";
import { appIdArg, confirmArg, PreconditionError, wrap } from "./util.js";

const frequency = z.enum(["NONE", "INFREQUENT_OR_MILD", "FREQUENT_OR_INTENSE"]);

const resolveDeclaration = async (client: AppStoreConnectClient, appId: string) => {
  const infos = await client.get(`/v1/apps/${appId}/appInfos`, { limit: 50 });
  const rows = (infos as { data?: Array<{ id?: string; attributes?: { state?: string } }> }).data ?? [];
  const info = rows.find((r) => r.attributes?.state?.includes("PREPARE")) ?? rows[0];
  if (!info?.id) throw new PreconditionError("No AppInfo exists for this app yet.", { appId });
  const response = await client.get(`/v1/appInfos/${info.id}/ageRatingDeclaration`);
  const declaration = resourceOf(response);
  return { appInfoId: info.id, declaration };
};

const declarationAttributes = (declaration: Record<string, unknown>): Record<string, unknown> =>
  isRecord(declaration.attributes) ? declaration.attributes : {};

export const registerComplianceTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  // Upstream v0.22+ registers app_store_connect_get_age_rating_declaration in appinfos.ts.
  // Keep only the fork's compatibility write helper here so MCP v2 never sees the same
  // read tool name twice during server construction.
  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_set_age_rating_declaration",
    {
      description:
        "Update the age-rating questionnaire. Apple requires a complete declaration on write, so this tool first reads the current declaration, merges only the fields you provide, and PATCHes the complete result. Requires confirm:true because these answers affect the public age rating.",
      inputSchema: {
        appId: appIdArg,
        violenceCartoonOrFantasy: frequency.optional(),
        violenceRealistic: frequency.optional(),
        violenceRealisticProlongedGraphicOrSadistic: frequency.optional(),
        profanityOrCrudeHumor: frequency.optional(),
        matureOrSuggestiveThemes: frequency.optional(),
        horrorOrFearThemes: frequency.optional(),
        medicalOrTreatmentInformation: frequency.optional(),
        alcoholTobaccoOrDrugUseOrReferences: frequency.optional(),
        gunsOrOtherWeapons: frequency.optional(),
        sexualContentOrNudity: frequency.optional(),
        sexualContentGraphicAndNudity: frequency.optional(),
        gamblingSimulated: frequency.optional(),
        contests: frequency.optional(),
        gambling: z.boolean().optional(),
        unrestrictedWebAccess: z.boolean().optional(),
        advertising: z.boolean().optional(),
        healthOrWellnessTopics: z.boolean().optional(),
        lootBox: z.boolean().optional(),
        messagingAndChat: z.boolean().optional(),
        parentalControls: z.boolean().optional(),
        ageAssurance: z.boolean().optional(),
        userGeneratedContent: z.boolean().optional(),
        kidsAgeBand: z
          .enum(["FIVE_AND_UNDER", "SIX_TO_EIGHT", "NINE_TO_ELEVEN"])
          .nullable()
          .optional(),
        additionalDeclarations: z.record(z.string(), z.unknown()).optional(),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (input) =>
      wrap(async () => {
        const { appId, additionalDeclarations, ...rest } = input;
        const { declaration } = await resolveDeclaration(client, appId);
        const supplied = Object.fromEntries(
          Object.entries(rest).filter(([key, value]) => key !== "confirm" && value !== undefined),
        );
        if (additionalDeclarations) Object.assign(supplied, additionalDeclarations);
        if (Object.keys(supplied).length === 0) {
          throw new PreconditionError("Pass at least one age-rating answer to change.", { appId });
        }
        const attributes = { ...declarationAttributes(declaration), ...supplied };
        await client.patch(`/v1/ageRatingDeclarations/${declaration.id}`, {
          data: { type: "ageRatingDeclarations", id: declaration.id, attributes },
        });
        return { updated: Object.keys(supplied), declarationId: declaration.id };
      }),
  );
};
