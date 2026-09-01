import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { isConfigured, setupInstructions, type Config } from "#/config";
import { wrap } from "#/tools/util";

/**
 * Registered unconditionally, before any credential check, so an unconfigured
 * server answers "here is what to set" instead of closing the connection with
 * its own explanation swallowed.
 */
export const registerStatusTool = (server: McpServer, config: Config): void => {
  server.registerTool(
    "app_store_connect_auth_status",
    {
      title: "App Store Connect: Auth Status",
      description:
        "Report whether this server has working App Store Connect credentials, whether writes " +
        "are enabled, which vendor number is set and where it came from, and — when something " +
        "is missing — exactly what to set. Call this first when a tool you expected is not " +
        "listed: an absent tool here means missing configuration rather than a bug.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => ({
        configured: isConfigured(config),
        keyId: config.keyId ?? null,
        issuerId: config.issuerId ? "set" : null,
        privateKey: config.privateKey ? "loaded" : null,
        vendorNumber: config.vendorNumber ?? null,
        vendorNumberSource: config.vendorNumberSource ?? null,
        metadataRoot: config.metadataRoot,
        writes: config.allowWrites ? "ENABLED" : "disabled",
        setup: setupInstructions(config),
      })),
  );
};
