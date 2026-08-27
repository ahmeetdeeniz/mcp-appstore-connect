import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient, Query } from "../client/asc.js";
import { confirmArg, wrap } from "./util.js";

const rawPathArg = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (!/^\/v[12]\//.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Raw App Store Connect paths must start with /v1/ or /v2/.",
      });
    }
    if (value.includes("://") || value.includes("?") || value.includes("#")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Pass only an API path here — no absolute URL, query string or fragment. Put query parameters in `query`.",
      });
    }
    if (value.split("/").includes("..")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Raw API paths may not contain `..` path traversal segments.",
      });
    }
  })
  .describe(
    "Relative App Store Connect API path, e.g. /v1/apps or /v2/inAppPurchases/123. Absolute URLs are refused.",
  );

const rawQueryValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const rawQueryArg = z
  .record(z.string(), rawQueryValue)
  .optional()
  .describe(
    'JSON:API query parameters, e.g. {"filter[bundleId]":"com.acme.app","limit":50}. Arrays are joined with commas.',
  );

const rawBodyArg = z
  .unknown()
  .optional()
  .describe("JSON request body. For Apple writes this is normally a JSON:API { data: ... } envelope.");

/**
 * A second, environment-only safety latch for generic mutation tools. Keeping it
 * out of the persistent config file is deliberate: normal typed writes can be a
 * standing preference, while unrestricted raw writes should be a conscious
 * per-process opt-in.
 */
export const rawWritesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const value = env.APP_STORE_CONNECT_ALLOW_RAW_WRITES?.trim().toLowerCase();
  return value !== undefined && ["1", "true", "yes", "on"].includes(value);
};

const queryOf = (query: Record<string, string | number | boolean | string[]> | undefined): Query | undefined =>
  query as Query | undefined;

export const registerRawTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_raw_get",
    {
      description:
        "Read any App Store Connect /v1 or /v2 endpoint that does not yet have a typed MCP tool. " +
        "This is the safe escape hatch for new Apple endpoints: it only performs GET, refuses " +
        "absolute URLs, and sends the JWT only to the configured App Store Connect API host. " +
        "Prefer typed tools when one exists because they add validation and clearer errors.",
      inputSchema: { path: rawPathArg, query: rawQueryArg },
      annotations: { readOnlyHint: true },
    },
    async ({ path, query }) =>
      wrap(async () => client.request("GET", path, { query: queryOf(query) })),
  );

  // Raw mutation is intentionally harder to enable than normal typed writes:
  // both latches must be on. This prevents APP_STORE_CONNECT_ALLOW_WRITES=1 from
  // silently turning a generic POST/PATCH/DELETE primitive into an agent tool.
  if (!allowWrites || !rawWritesEnabled()) return;

  server.registerTool(
    "app_store_connect_raw_mutate",
    {
      description:
        "POST or PATCH an App Store Connect /v1 or /v2 endpoint that has no typed tool. " +
        "Available only when BOTH APP_STORE_CONNECT_ALLOW_WRITES=1 and the environment-only " +
        "APP_STORE_CONNECT_ALLOW_RAW_WRITES=1 are set. Prefer typed write tools whenever possible.",
      inputSchema: {
        method: z.enum(["POST", "PATCH"]),
        path: rawPathArg,
        query: rawQueryArg,
        body: rawBodyArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ method, path, query, body }) =>
      wrap(async () => client.request(method, path, { query: queryOf(query), body })),
  );

  server.registerTool(
    "app_store_connect_raw_delete",
    {
      description:
        "DELETE an App Store Connect /v1 or /v2 resource that has no typed delete tool. This is " +
        "the most dangerous escape hatch: it is hidden unless normal writes and raw writes are " +
        "both enabled, and every call additionally requires confirm: true.",
      inputSchema: {
        path: rawPathArg,
        query: rawQueryArg,
        body: rawBodyArg,
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ path, query, body }) =>
      wrap(async () => client.request("DELETE", path, { query: queryOf(query), body })),
  );
};
