import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { confirmArg, limitArg, wrap } from "./util.js";

export const registerXcodeCloudTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_xcode_cloud_products",
    {
      description: "List Xcode Cloud products available to this App Store Connect account.",
      inputSchema: { limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => wrap(async () => summarizeResponse(await client.get("/v1/ciProducts", { limit }))),
  );

  server.registerTool(
    "app_store_connect_list_xcode_cloud_workflows",
    {
      description: "List Xcode Cloud workflows for a CI product.",
      inputSchema: { ciProductId: z.string().min(1), limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ ciProductId, limit }) => wrap(async () => summarizeResponse(
      await client.get(`/v1/ciProducts/${ciProductId}/workflows`, { limit }),
    )),
  );

  server.registerTool(
    "app_store_connect_list_xcode_cloud_build_runs",
    {
      description: "List recent Xcode Cloud build runs for a workflow.",
      inputSchema: { workflowId: z.string().min(1), limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ workflowId, limit }) => wrap(async () => summarizeResponse(
      await client.get(`/v1/ciWorkflows/${workflowId}/buildRuns`, { limit, sort: "-number" }),
    )),
  );

  server.registerTool(
    "app_store_connect_get_xcode_cloud_build_run",
    {
      description: "Get one Xcode Cloud build run and its actions/status.",
      inputSchema: { buildRunId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ buildRunId }) => wrap(async () => summarizeResponse(
      await client.get(`/v1/ciBuildRuns/${buildRunId}`, { include: "actions" }),
    )),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_start_xcode_cloud_build",
    {
      description: "Start a new Xcode Cloud build for a workflow. Requires confirm:true because this consumes CI resources and may trigger downstream automation.",
      inputSchema: {
        workflowId: z.string().min(1),
        sourceBranchOrTagId: z.string().min(1).optional(),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ workflowId, sourceBranchOrTagId }) => wrap(async () => {
      const relationships: Record<string, unknown> = {
        workflow: { data: { type: "ciWorkflows", id: workflowId } },
      };
      if (sourceBranchOrTagId) {
        relationships.sourceBranchOrTag = { data: { type: "scmGitReferences", id: sourceBranchOrTagId } };
      }
      return summarizeResponse(await client.post("/v1/ciBuildRuns", {
        data: { type: "ciBuildRuns", relationships },
      }));
    }),
  );
};
