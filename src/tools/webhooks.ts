import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { appIdArg, confirmArg, limitArg, PreconditionError, wrap } from "./util.js";

const httpsUrl = z.string().url().superRefine((value, ctx) => {
  if (!value.startsWith("https://")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Webhook URLs must use HTTPS." });
});

export const registerWebhookTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_webhooks",
    {
      description: "List App Store Connect webhooks configured for an app.",
      inputSchema: { appId: appIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit }) => wrap(async () => summarizeResponse(
      await client.get(`/v1/apps/${appId}/webhooks`, { limit }),
    )),
  );

  server.registerTool(
    "app_store_connect_list_webhook_deliveries",
    {
      description: "List recent delivery attempts for a webhook, useful for debugging event delivery.",
      inputSchema: { webhookId: z.string().min(1), limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ webhookId, limit }) => wrap(async () => summarizeResponse(
      await client.get(`/v1/webhooks/${webhookId}/deliveries`, { limit, sort: "-createdDate" }),
    )),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_webhook",
    {
      description: "Create an HTTPS App Store Connect webhook. The signing secret is sent only in this write and is never echoed by this tool. Requires confirm:true because it enables outbound event delivery.",
      inputSchema: {
        appId: appIdArg,
        name: z.string().min(1),
        url: httpsUrl,
        eventTypes: z.array(z.string().min(1)).min(1),
        secret: z.string().min(16).describe("Signing secret used to verify webhook deliveries."),
        enabled: z.boolean().default(true),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ appId, name, url, eventTypes, secret, enabled }) => wrap(async () => {
      const result = await client.post<{ data?: { id?: string; attributes?: Record<string, unknown> } }>("/v1/webhooks", {
        data: {
          type: "webhooks",
          attributes: { name, url, eventTypes, secret, enabled },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      });
      return { webhookId: result.data?.id, configured: true, secretReturned: false };
    }),
  );

  server.registerTool(
    "app_store_connect_update_webhook",
    {
      description: "Update a webhook's name, HTTPS URL, event types, enabled state, or signing secret. Requires confirm:true.",
      inputSchema: {
        webhookId: z.string().min(1),
        name: z.string().min(1).optional(),
        url: httpsUrl.optional(),
        eventTypes: z.array(z.string().min(1)).min(1).optional(),
        enabled: z.boolean().optional(),
        secret: z.string().min(16).optional(),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ webhookId, confirm: _confirm, ...values }) => wrap(async () => {
      const attributes = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
      if (Object.keys(attributes).length === 0) throw new PreconditionError("Pass at least one webhook field to update.", { webhookId });
      await client.patch(`/v1/webhooks/${webhookId}`, { data: { type: "webhooks", id: webhookId, attributes } });
      return { webhookId, updated: Object.keys(attributes), secretReturned: false };
    }),
  );

  server.registerTool(
    "app_store_connect_ping_webhook",
    {
      description: "Send a test delivery to a configured webhook. Requires confirm:true because it produces outbound traffic.",
      inputSchema: { webhookId: z.string().min(1), confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ webhookId }) => wrap(async () => summarizeResponse(await client.post("/v1/webhookPings", {
      data: { type: "webhookPings", relationships: { webhook: { data: { type: "webhooks", id: webhookId } } } },
    }))),
  );

  server.registerTool(
    "app_store_connect_delete_webhook",
    {
      description: "Delete a webhook permanently. Requires confirm:true.",
      inputSchema: { webhookId: z.string().min(1), confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ webhookId }) => wrap(async () => {
      await client.del(`/v1/webhooks/${webhookId}`);
      return { deleted: webhookId };
    }),
  );
};
