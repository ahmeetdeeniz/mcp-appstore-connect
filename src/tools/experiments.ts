import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { appIdArg, confirmArg, wrap } from "./util.js";

const platformArg = z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);
const experimentIdArg = z.string().min(1).describe("The Product Page Optimization experiment id.");
const treatmentIdArg = z.string().min(1).describe("The experiment treatment id.");

export const registerExperimentTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_product_page_experiments",
    {
      description:
        "List an app's Product Page Optimization experiments, including state, traffic split and dates.",
      inputSchema: { appId: appIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/apps/${appId}/appStoreVersionExperimentsV2`, {
            limit: 200,
            "fields[appStoreVersionExperiments]":
              "name,state,trafficProportion,startDate,endDate,reviewRequired",
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_product_page_experiment",
    {
      description:
        "Get one Product Page Optimization experiment plus its treatment variants.",
      inputSchema: { experimentId: experimentIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ experimentId }) =>
      wrap(async () => {
        const [experiment, treatments] = await Promise.all([
          client.get(`/v2/appStoreVersionExperiments/${experimentId}`, {
            "fields[appStoreVersionExperiments]":
              "name,state,trafficProportion,startDate,endDate,reviewRequired",
          }),
          client.get(
            `/v2/appStoreVersionExperiments/${experimentId}/appStoreVersionExperimentTreatments`,
            { limit: 50 },
          ),
        ]);
        return { experiment: summarizeResponse(experiment), treatments: summarizeResponse(treatments) };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_product_page_experiment",
    {
      description:
        "Create a Product Page Optimization experiment. Add treatments and their localized visuals before starting it.",
      inputSchema: {
        appId: appIdArg,
        name: z.string().min(1).max(64),
        platform: platformArg.default("IOS"),
        trafficProportion: z.number().int().min(1).max(100),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appId, name, platform, trafficProportion }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v2/appStoreVersionExperiments", {
            data: {
              type: "appStoreVersionExperiments",
              attributes: { name, platform, trafficProportion },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_create_product_page_treatment",
    {
      description:
        "Create a treatment variant inside a Product Page Optimization experiment. Optionally reference an alternate app icon.",
      inputSchema: {
        experimentId: experimentIdArg,
        name: z.string().min(1).max(64),
        appIconName: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ experimentId, name, appIconName }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/appStoreVersionExperimentTreatments", {
            data: {
              type: "appStoreVersionExperimentTreatments",
              attributes: { name, ...(appIconName ? { appIconName } : {}) },
              relationships: {
                appStoreVersionExperimentV2: {
                  data: { type: "appStoreVersionExperiments", id: experimentId },
                },
              },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_ensure_product_page_treatment_localization",
    {
      description:
        "Find or create a treatment localization for a locale. The returned id is the parent for treatment screenshots/previews.",
      inputSchema: { treatmentId: treatmentIdArg, locale: z.string().min(2) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ treatmentId, locale }) =>
      wrap(async () => {
        const existing = await client.get(
          `/v1/appStoreVersionExperimentTreatments/${treatmentId}/appStoreVersionExperimentTreatmentLocalizations`,
          { limit: 200, "fields[appStoreVersionExperimentTreatmentLocalizations]": "locale" },
        );
        const rows = (existing as { data?: Array<{ id?: string; attributes?: { locale?: string } }> }).data ?? [];
        const match = rows.find((row) => row.attributes?.locale === locale);
        if (match?.id) return { id: match.id, locale, action: "found" };
        const created = await client.post("/v1/appStoreVersionExperimentTreatmentLocalizations", {
          data: {
            type: "appStoreVersionExperimentTreatmentLocalizations",
            attributes: { locale },
            relationships: {
              appStoreVersionExperimentTreatment: {
                data: { type: "appStoreVersionExperimentTreatments", id: treatmentId },
              },
            },
          },
        });
        return { action: "created", result: summarizeResponse(created) };
      }),
  );

  server.registerTool(
    "app_store_connect_set_product_page_experiment_running",
    {
      description:
        "Start or stop a Product Page Optimization experiment. This changes live traffic allocation and therefore requires explicit confirmation.",
      inputSchema: {
        experimentId: experimentIdArg,
        started: z.boolean(),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ experimentId, started }) =>
      wrap(async () =>
        summarizeResponse(
          await client.patch(`/v2/appStoreVersionExperiments/${experimentId}`, {
            data: {
              type: "appStoreVersionExperiments",
              id: experimentId,
              attributes: { started },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_delete_product_page_treatment",
    {
      description: "Delete a Product Page Optimization treatment variant.",
      inputSchema: { treatmentId: treatmentIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ treatmentId }) =>
      wrap(async () => {
        await client.del(`/v1/appStoreVersionExperimentTreatments/${treatmentId}`);
        return { deleted: treatmentId };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_product_page_experiment",
    {
      description: "Delete a Product Page Optimization experiment.",
      inputSchema: { experimentId: experimentIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ experimentId }) =>
      wrap(async () => {
        await client.del(`/v2/appStoreVersionExperiments/${experimentId}`);
        return { deleted: experimentId };
      }),
  );
};
