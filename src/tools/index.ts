import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppStoreConnectClient } from "../client/asc.js";
import type { Contact } from "../config.js";
import { registerAppEventTools } from "./appevents.js";
import { registerAppInfoTools } from "./appinfos.js";
import { registerAppTools } from "./apps.js";
import { registerBuildTools } from "./builds.js";
import { registerBundleIdTools } from "./bundleids.js";
import { registerCategoryTools } from "./categories.js";
import { registerCertificateTools } from "./certificates.js";
import { registerCustomerReviewTools } from "./customerreviews.js";
import { registerCustomProductPageTools } from "./customproductpages.js";
import { registerDeviceTools } from "./devices.js";
import { registerExperimentTools } from "./experiments.js";
import { registerIapTools } from "./iap.js";
import { registerListingTools } from "./listing.js";
import { registerMarketingAssetTools } from "./marketingassets.js";
import { registerOperatorTools } from "./operator.js";
import { registerPricingTools } from "./pricing.js";
import { registerRawTools } from "./raw.js";
import { registerReleaseDoctorTools } from "./releasedoctor.js";
import { registerReportTools } from "./reports.js";
import { registerReviewDetailTools } from "./reviewdetails.js";
import { registerScreenshotTools } from "./screenshots.js";
import { registerSubmissionTools } from "./submissions.js";
import { registerSubscriptionOfferTools } from "./subscriptionoffers.js";
import { registerSubscriptionTools } from "./subscriptions.js";
import { registerTestflightTools } from "./testflight.js";
import { registerUserTools } from "./users.js";
import { registerVersionTools } from "./versions.js";
import { registerWorkflowTools } from "./workflows.js";

export type ToolContext = {
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

export const registerTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  ctx: ToolContext,
): void => {
  const { allowWrites } = ctx;
  registerOperatorTools(server, client);
  registerWorkflowTools(server, client);
  registerAppTools(server, client, allowWrites);
  registerVersionTools(server, client, allowWrites);
  registerSubmissionTools(server, client, allowWrites);
  registerReleaseDoctorTools(server, client);
  registerAppInfoTools(server, client, allowWrites);
  registerCategoryTools(server, client, allowWrites);
  registerPricingTools(server, client, allowWrites);
  registerReviewDetailTools(server, client, ctx);
  registerIapTools(server, client, allowWrites);
  registerSubscriptionTools(server, client, allowWrites);
  registerSubscriptionOfferTools(server, client, allowWrites);
  registerListingTools(server, client, ctx);
  registerCustomProductPageTools(server, client, allowWrites);
  registerAppEventTools(server, client, allowWrites);
  registerExperimentTools(server, client, allowWrites);
  registerMarketingAssetTools(server, client, allowWrites);
  registerScreenshotTools(server, client, allowWrites);
  registerBuildTools(server, client, allowWrites);
  registerTestflightTools(server, client, allowWrites);
  registerReportTools(server, client, ctx);
  registerCustomerReviewTools(server, client, allowWrites);
  registerUserTools(server, client, allowWrites);
  registerBundleIdTools(server, client, allowWrites);
  registerDeviceTools(server, client, allowWrites);
  registerCertificateTools(server, client, allowWrites);
  registerRawTools(server, client, allowWrites);
};
