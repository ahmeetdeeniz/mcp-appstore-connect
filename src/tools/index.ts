import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import type { Contact } from "#/config";
import { isConfigured, type Config } from "#/config";
import { registerAppEventTools } from "#/tools/appevents";
import { registerAppInfoTools } from "#/tools/appinfos";
import { registerAppTools } from "#/tools/apps";
import { registerBuildTools } from "#/tools/builds";
import { registerBuildUploadTools } from "#/tools/builduploads";
import { registerBundleIdTools } from "#/tools/bundleids";
import { registerCategoryTools } from "#/tools/categories";
import { registerCertificateTools } from "#/tools/certificates";
import { registerComplianceTools } from "#/tools/compliance";
import { registerCustomerReviewTools } from "#/tools/customerreviews";
import { registerCustomProductPageTools } from "#/tools/customproductpages";
import { registerDeviceTools } from "#/tools/devices";
import { registerExperimentTools } from "#/tools/experiments";
import { registerIapTools } from "#/tools/iap";
import { registerListingTools } from "#/tools/listing";
import { registerMarketingAssetTools } from "#/tools/marketingassets";
import { registerOperatorTools } from "#/tools/operator";
import { registerPricingTools } from "#/tools/pricing";
import { registerRawTools } from "#/tools/raw";
import { registerReleaseDoctorTools } from "#/tools/releasedoctor";
import { registerReportTools } from "#/tools/reports";
import { registerReviewDetailTools } from "#/tools/reviewdetails";
import { registerScreenshotTools } from "#/tools/screenshots";
import { registerStatusTool } from "#/tools/status";
import { registerSubmissionTools } from "#/tools/submissions";
import { registerSubscriptionOfferTools } from "#/tools/subscriptionoffers";
import { registerSubscriptionTools } from "#/tools/subscriptions";
import { registerTestflightTools } from "#/tools/testflight";
import { registerUserTools } from "#/tools/users";
import { registerVersionTools } from "#/tools/versions";
import { registerWebhookTools } from "#/tools/webhooks";
import { registerWorkflowTools } from "#/tools/workflows";
import { registerXcodeCloudTools } from "#/tools/xcodecloud";

export type ToolContext = {
  config: Config;
  /** Register the mutating tools too. Off by default — see APP_STORE_CONNECT_ALLOW_WRITES. */
  allowWrites: boolean;
  /** Vendor number for sales/finance reports. Reports fail with a clear error when unset. */
  vendorNumber?: string | undefined;
  /** Which config layer supplied `vendorNumber`, reported by get_vendor_number. */
  vendorNumberSource?: "environment" | "file" | undefined;
  /** Where this repo keeps its metadata tree, already normalized. */
  metadataRoot: string;
  /** Configured App Review contact used to fill missing review-detail fields. */
  contact?: Contact | undefined;
};

type LegacyToolOptions = {
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
};

type LegacyToolHandler = (...args: any[]) => any;

/**
 * This fork added a large typed operator surface while the upstream project was on MCP v1,
 * where registerTool accepted a raw Zod shape. MCP v2 expects a Zod object schema instead.
 * Keep the extension modules source-compatible during the upstream migration by adapting
 * only their registration boundary. Upstream-native tools continue to receive the real server.
 */
const legacyRegistrationServer = (server: McpServer): any => ({
  registerTool: (name: string, options: LegacyToolOptions, handler: LegacyToolHandler) =>
    server.registerTool(
      name,
      {
        ...options,
        inputSchema: z.object((options.inputSchema ?? {}) as z.ZodRawShape),
      } as any,
      handler as any,
    ),
});

/**
 * Register the App Store Connect tools. Read tools are always registered; write
 * tools are only registered when `allowWrites` is set, so with the flag off they
 * are not merely refused — they are invisible, and cannot be called at all.
 */
export const registerTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  ctx: ToolContext,
): void => {
  const { allowWrites } = ctx;

  // Registered first and unconditionally, so an unconfigured server can explain
  // what credentials are missing instead of disappearing with CONNECTION_CLOSED.
  registerStatusTool(server, ctx.config);
  if (!isConfigured(ctx.config)) return;

  const legacyServer = legacyRegistrationServer(server);

  // Fork-specific, client-neutral operator surfaces. These were authored against MCP v1
  // and are adapted at the registration boundary above while the rest of the repo runs v2.
  registerOperatorTools(legacyServer, client);
  registerWorkflowTools(legacyServer, client);
  registerReleaseDoctorTools(legacyServer, client);

  // Upstream-native v2 tools.
  registerAppTools(server, client, allowWrites);
  registerVersionTools(server, client, allowWrites);
  registerSubmissionTools(server, client, allowWrites);
  registerAppInfoTools(server, client, allowWrites);
  registerCategoryTools(server, client, allowWrites);
  registerPricingTools(server, client, allowWrites);
  registerReviewDetailTools(server, client, ctx);
  registerIapTools(server, client, allowWrites);
  registerListingTools(server, client, ctx);
  registerScreenshotTools(server, client, allowWrites);
  registerBuildTools(server, client, allowWrites);
  registerReportTools(server, client, ctx);
  registerUserTools(server, client, allowWrites);
  registerBundleIdTools(server, client, allowWrites);
  registerDeviceTools(server, client, allowWrites);
  registerCertificateTools(server, client, allowWrites);

  // Fork extensions and the two extended upstream modules retained from the v0.21 fork.
  registerComplianceTools(legacyServer, client, allowWrites);
  registerSubscriptionTools(legacyServer, client, allowWrites);
  registerSubscriptionOfferTools(legacyServer, client, allowWrites);
  registerCustomProductPageTools(legacyServer, client, allowWrites);
  registerAppEventTools(legacyServer, client, allowWrites);
  registerExperimentTools(legacyServer, client, allowWrites);
  registerMarketingAssetTools(legacyServer, client, allowWrites);
  registerBuildUploadTools(legacyServer, client, allowWrites);
  registerTestflightTools(legacyServer, client, allowWrites);
  registerXcodeCloudTools(legacyServer, client, allowWrites);
  registerWebhookTools(legacyServer, client, allowWrites);
  registerCustomerReviewTools(legacyServer, client, allowWrites);
  registerRawTools(legacyServer, client, allowWrites);
};
