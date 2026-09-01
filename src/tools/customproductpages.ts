import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { attributesOf, resourcesOf, summarizeResponse } from "../client/shape.js";
import { appIdArg, confirmArg, limitArg, wrap } from "./util.js";

const pageIdArg = z.string().min(1).describe("The appCustomProductPage id.");
const pageVersionIdArg = z.string().min(1).describe("The appCustomProductPageVersion id.");

const resolveDraftVersion = async (
  client: AppStoreConnectClient,
  pageId: string,
  createIfMissing: boolean,
): Promise<{ id?: string; created: boolean }> => {
  const versions = resourcesOf(
    await client.get(`/v1/appCustomProductPages/${pageId}/appCustomProductPageVersions`, {
      limit: 50,
      "fields[appCustomProductPageVersions]": ["state", "version"],
    }),
  );
  const draft =
    versions.find((row) => attributesOf(row).state === "PREPARE_FOR_SUBMISSION") ?? versions[0];
  if (draft && typeof draft.id === "string") return { id: draft.id, created: false };
  if (!createIfMissing) return { created: false };

  const created = await client.post<{ data?: { id?: string } }>("/v1/appCustomProductPageVersions", {
    data: {
      type: "appCustomProductPageVersions",
      relationships: {
        appCustomProductPage: { data: { type: "appCustomProductPages", id: pageId } },
      },
    },
  });
  const id = created.data?.id;
  if (!id) throw new Error("Creating the Custom Product Page draft version returned no id.");
  return { id, created: true };
};

export const registerCustomProductPageTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_custom_product_pages",
    {
      description:
        "List an app's Custom Product Pages — alternate store pages used for campaigns, each with its own shareable URL and visibility state.",
      inputSchema: { appId: appIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/apps/${appId}/appCustomProductPages`, {
            limit,
            "fields[appCustomProductPages]": ["name", "url", "visible"],
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_custom_product_page",
    {
      description:
        "Get one Custom Product Page plus its versions and the localizations on its editable draft version.",
      inputSchema: { customProductPageId: pageIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ customProductPageId }) =>
      wrap(async () => {
        const page = await client.get(`/v1/appCustomProductPages/${customProductPageId}`, {
          "fields[appCustomProductPages]": ["name", "url", "visible"],
        });
        const versionsResponse = await client.get(
          `/v1/appCustomProductPages/${customProductPageId}/appCustomProductPageVersions`,
          { limit: 50, "fields[appCustomProductPageVersions]": ["state", "version"] },
        );
        const versions = resourcesOf(versionsResponse).map(
          (row): Record<string, unknown> => ({
            id: row.id,
            ...attributesOf(row),
          }),
        );
        const draft =
          versions.find((version) => version.state === "PREPARE_FOR_SUBMISSION") ?? versions[0];
        const localizations =
          draft && typeof draft.id === "string"
            ? summarizeResponse(
                await client.get(
                  `/v1/appCustomProductPageVersions/${draft.id}/appCustomProductPageLocalizations`,
                  {
                    limit: 200,
                    "fields[appCustomProductPageLocalizations]": ["locale", "promotionalText"],
                  },
                ),
              )
            : { data: [] };
        return {
          page: summarizeResponse(page),
          versions,
          draftVersionId: draft?.id,
          localizations,
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_custom_product_page",
    {
      description:
        "Create a Custom Product Page and ensure it has an editable draft version. Returns both ids for the next localization step.",
      inputSchema: {
        appId: appIdArg,
        name: z.string().min(1).max(64).describe("Internal reference name for the page."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appId, name }) =>
      wrap(async () => {
        const response = await client.post<{
          data?: { id?: string; attributes?: Record<string, unknown> };
        }>("/v1/appCustomProductPages", {
          data: {
            type: "appCustomProductPages",
            attributes: { name },
            relationships: { app: { data: { type: "apps", id: appId } } },
          },
        });
        const pageId = response.data?.id;
        if (!pageId) throw new Error("Creating the Custom Product Page returned no id.");
        const draft = await resolveDraftVersion(client, pageId, true);
        return {
          customProductPageId: pageId,
          draftVersionId: draft.id,
          draftCreated: draft.created,
          ...response.data?.attributes,
        };
      }),
  );

  server.registerTool(
    "app_store_connect_set_custom_product_page_localization",
    {
      description:
        "Upsert a Custom Product Page localization on its draft version. Promotional text is limited to 170 UTF-16 code units, matching the normal store listing field.",
      inputSchema: {
        versionId: pageVersionIdArg,
        locale: z.string().min(2),
        promotionalText: z.string().max(170).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ versionId, locale, promotionalText }) =>
      wrap(async () => {
        const existing = resourcesOf(
          await client.get(
            `/v1/appCustomProductPageVersions/${versionId}/appCustomProductPageLocalizations`,
            { limit: 200, "fields[appCustomProductPageLocalizations]": ["locale"] },
          ),
        );
        const match = existing.find((row) => attributesOf(row).locale === locale);
        const attributes = promotionalText === undefined ? {} : { promotionalText };
        if (match && typeof match.id === "string") {
          return summarizeResponse(
            await client.patch(`/v1/appCustomProductPageLocalizations/${match.id}`, {
              data: {
                type: "appCustomProductPageLocalizations",
                id: match.id,
                attributes,
              },
            }),
          );
        }
        return summarizeResponse(
          await client.post("/v1/appCustomProductPageLocalizations", {
            data: {
              type: "appCustomProductPageLocalizations",
              attributes: { locale, ...attributes },
              relationships: {
                appCustomProductPageVersion: {
                  data: { type: "appCustomProductPageVersions", id: versionId },
                },
              },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_delete_custom_product_page",
    {
      description:
        "Permanently delete a Custom Product Page. This removes the campaign page and cannot be undone.",
      inputSchema: { customProductPageId: pageIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ customProductPageId }) =>
      wrap(async () => {
        await client.del(`/v1/appCustomProductPages/${customProductPageId}`);
        return { deleted: customProductPageId };
      }),
  );
};
