import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { attributesOf, resourcesOf, summarizeResponse } from "../client/shape.js";
import type { ToolContext } from "./index.js";
import { appIdArg, compact, limitArg, PreconditionError, wrap } from "./util.js";

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;

/** Apple's analytics report categories, as accepted by `filter[category]`. */
const REPORT_CATEGORIES = [
  "APP_USAGE",
  "APP_STORE_ENGAGEMENT",
  "COMMERCE",
  "FRAMEWORK_USAGE",
  "PERFORMANCE",
] as const;

const GRANULARITIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;

/**
 * A segment is one gzipped CSV of a report instance. Big apps produce big ones,
 * and the whole file is decompressed in this process before being truncated, so
 * the compressed size is checked against this before anything is fetched.
 */
const DEFAULT_MAX_SEGMENT_BYTES = 25 * 1024 * 1024;

const SALES_REPORT_TYPES = [
  "SALES",
  "PRE_ORDER",
  "SUBSCRIPTION",
  "SUBSCRIPTION_EVENT",
  "SUBSCRIBER",
  "NEWSSTAND",
  "INSTALLS",
  "FIRST_ANNUAL",
] as const;

/** Trim a downloaded TSV report so a huge one doesn't blow the context window. */
const previewReport = (tsv: string, maxLines: number): Record<string, unknown> => {
  const lines = tsv.split("\n");
  const truncated = lines.length > maxLines;
  return {
    rows: lines.length,
    truncated,
    ...(truncated ? { note: `Showing first ${maxLines} of ${lines.length} lines.` } : {}),
    report: (truncated ? lines.slice(0, maxLines) : lines).join("\n"),
  };
};

const requireVendor = (arg: string | undefined, ctxVendor: string | undefined): string => {
  const vendor = arg ?? ctxVendor;
  if (!vendor) {
    throw new Error(
      "A vendor number is required for reports. Set APP_STORE_CONNECT_VENDOR_NUMBER " +
        "(Payments and Financial Reports in App Store Connect) or pass `vendorNumber`.",
    );
  }
  return vendor;
};

export const registerReportTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "app_store_connect_download_sales_report",
    {
      description:
        "Download a sales & trends report (units, proceeds) as TSV. Reports lag ~24h and are " +
        "keyed by date: DAILY needs YYYY-MM-DD, WEEKLY the week-ending Sunday, MONTHLY YYYY-MM, " +
        "YEARLY YYYY. Requires a vendor number.",
      inputSchema: {
        reportDate: z
          .string()
          .min(1)
          .describe("Report date: YYYY-MM-DD (daily/weekly), YYYY-MM (monthly), or YYYY (yearly)."),
        frequency: z.enum(FREQUENCIES).default("MONTHLY"),
        reportType: z.enum(SALES_REPORT_TYPES).default("SALES"),
        reportSubType: z
          .enum(["SUMMARY", "DETAILED", "SUMMARY_INSTALL_TYPE", "SUMMARY_TERRITORY"])
          .default("SUMMARY"),
        vendorNumber: z
          .string()
          .optional()
          .describe("Override APP_STORE_CONNECT_VENDOR_NUMBER for this call."),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe("Truncate the TSV to this many lines. Defaults to 500."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ reportDate, frequency, reportType, reportSubType, vendorNumber, maxLines }) =>
      wrap(async () => {
        const vendor = requireVendor(vendorNumber, ctx.vendorNumber);
        const tsv = await client.downloadReport("/v1/salesReports", {
          "filter[frequency]": frequency,
          "filter[reportType]": reportType,
          "filter[reportSubType]": reportSubType,
          "filter[vendorNumber]": vendor,
          "filter[reportDate]": reportDate,
        });
        return previewReport(tsv, maxLines);
      }),
  );

  server.registerTool(
    "app_store_connect_download_finance_report",
    {
      description:
        "Download a financial report (proceeds by region) as TSV for one fiscal month and region. " +
        "Requires a vendor number.",
      inputSchema: {
        reportDate: z.string().min(1).describe("Fiscal period as YYYY-MM."),
        regionCode: z
          .string()
          .min(1)
          .describe('Financial region code, e.g. "ZZ" for all regions, "US", "EU", "JP".'),
        vendorNumber: z
          .string()
          .optional()
          .describe("Override APP_STORE_CONNECT_VENDOR_NUMBER for this call."),
        maxLines: z.number().int().min(1).max(5000).default(500),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ reportDate, regionCode, vendorNumber, maxLines }) =>
      wrap(async () => {
        const vendor = requireVendor(vendorNumber, ctx.vendorNumber);
        const tsv = await client.downloadReport("/v1/financeReports", {
          "filter[regionCode]": regionCode,
          "filter[reportType]": "FINANCIAL",
          "filter[vendorNumber]": vendor,
          "filter[reportDate]": reportDate,
        });
        return previewReport(tsv, maxLines);
      }),
  );

  server.registerTool(
    "app_store_connect_list_analytics_report_requests",
    {
      description:
        "List an app's existing analytics report requests. Step 1 of reading analytics: a request " +
        "is created once per app and then keeps producing reports, so list first and reuse the id " +
        "rather than creating a second one (Apple rejects a duplicate ONGOING request). Then: " +
        "list_analytics_reports -> list_analytics_report_instances -> " +
        "download_analytics_report_segment.",
      inputSchema: {
        appId: appIdArg,
        accessType: z
          .enum(["ONE_TIME_SNAPSHOT", "ONGOING"])
          .optional()
          .describe("Filter by access type. Omit to list both."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, accessType, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/analyticsReportRequests`,
            compact({ "filter[accessType]": accessType, limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_analytics_reports",
    {
      description:
        "List the reports produced for an analytics report request (step 2). Each report is a " +
        "named dataset — installs and deletions, discovery and engagement, sales, retention — and " +
        "carries no data itself: pass its id to app_store_connect_list_analytics_report_instances " +
        "to reach the dated instances holding the numbers. An empty list means Apple has not " +
        "finished generating them yet (allow a day or two after creating the request).",
      inputSchema: {
        reportRequestId: z
          .string()
          .min(1)
          .describe(
            "The analyticsReportRequest id, from app_store_connect_list_analytics_report_requests.",
          ),
        category: z
          .enum(REPORT_CATEGORIES)
          .optional()
          .describe(
            "Filter by category. APP_STORE_ENGAGEMENT covers impressions, product page views and " +
              "conversion; APP_USAGE covers installs, sessions and retention; COMMERCE covers " +
              "sales and proceeds.",
          ),
        name: z
          .string()
          .optional()
          .describe('Filter by exact report name, e.g. "App Store Installation and Deletion".'),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ reportRequestId, category, name, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/analyticsReportRequests/${reportRequestId}/reports`,
            compact({ "filter[category]": category, "filter[name]": name, limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_analytics_report_instances",
    {
      description:
        "List the instances of an analytics report (step 3) — one per granularity and processing " +
        "date. Pick the instance you want, then pass its id to " +
        "app_store_connect_download_analytics_report_segment to get the actual rows. Filter by " +
        "granularity first: a report usually has one instance per day, so an unfiltered list is " +
        "mostly noise.",
      inputSchema: {
        reportId: z
          .string()
          .min(1)
          .describe("The analyticsReport id, from app_store_connect_list_analytics_reports."),
        granularity: z
          .enum(GRANULARITIES)
          .optional()
          .describe("Filter by granularity. Not every report offers all three."),
        processingDate: z
          .string()
          .optional()
          .describe("Filter to one processing date, as YYYY-MM-DD."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ reportId, granularity, processingDate, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/analyticsReports/${reportId}/instances`,
            compact({
              "filter[granularity]": granularity,
              "filter[processingDate]": processingDate,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_analytics_report_segments",
    {
      description:
        "List the segments of an analytics report instance — the files the data is split across, " +
        "with their compressed size and checksum. Use this to see how large a download will be; " +
        "app_store_connect_download_analytics_report_segment fetches one. The `url` on a segment " +
        "expires within minutes, so re-list rather than reusing an old one.",
      inputSchema: {
        instanceId: z
          .string()
          .min(1)
          .describe(
            "The analyticsReportInstance id, from " +
              "app_store_connect_list_analytics_report_instances.",
          ),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instanceId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/analyticsReportInstances/${instanceId}/segments`,
            compact({ limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_download_analytics_report_segment",
    {
      description:
        "Download the actual analytics data for a report instance (step 4) and return it as text. " +
        "This is the only tool that reaches the numbers — impressions, product page views, " +
        "installs, deletions, sessions, retention, proceeds — depending on which report the " +
        "instance belongs to. Resolves the instance's segments itself, so no expiring url has to " +
        "be passed around. A report split across several segments needs one call per segmentIndex.",
      inputSchema: {
        instanceId: z
          .string()
          .min(1)
          .describe(
            "The analyticsReportInstance id, from " +
              "app_store_connect_list_analytics_report_instances.",
          ),
        segmentIndex: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Which segment to download, when the instance has more than one. 0-based."),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe("Truncate the returned rows to this many lines. Defaults to 500."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .default(DEFAULT_MAX_SEGMENT_BYTES)
          .describe(
            "Refuse a segment whose compressed size exceeds this, before downloading it. " +
              "Defaults to 25 MiB.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instanceId, segmentIndex, maxLines, maxBytes }) =>
      wrap(async () => {
        const response = await client.get(`/v1/analyticsReportInstances/${instanceId}/segments`);
        const segments = resourcesOf(response);
        if (segments.length === 0) {
          throw new PreconditionError(
            "This report instance has no segments. Apple is still generating it, or it holds no " +
              "data for that date — pick another instance.",
            { instanceId },
          );
        }

        const segment = segments[segmentIndex];
        if (!segment) {
          throw new PreconditionError(
            `Segment ${segmentIndex} does not exist — this instance has ${segments.length}.`,
            { instanceId, segments: segments.length },
          );
        }

        const attributes = attributesOf(segment);
        const sizeInBytes = typeof attributes.sizeInBytes === "number" ? attributes.sizeInBytes : 0;
        if (sizeInBytes > maxBytes) {
          throw new PreconditionError(
            `Segment ${segmentIndex} is ${sizeInBytes} bytes compressed, over the ${maxBytes} ` +
              `byte limit. Raise maxBytes to fetch it anyway, or pick a narrower instance ` +
              `(a DAILY granularity covers far less than MONTHLY).`,
            { instanceId, segmentIndex, sizeInBytes, maxBytes },
          );
        }
        if (typeof attributes.url !== "string" || attributes.url === "") {
          throw new PreconditionError(`Segment ${segmentIndex} came back without a download url.`, {
            instanceId,
            segmentIndex,
          });
        }

        const csv = await client.downloadSignedFile(attributes.url);
        return {
          segment: {
            index: segmentIndex,
            of: segments.length,
            ...(typeof attributes.checksum === "string" ? { checksum: attributes.checksum } : {}),
            sizeInBytes,
          },
          ...previewReport(csv, maxLines),
        };
      }),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "app_store_connect_create_analytics_report_request",
    {
      description:
        "Request analytics reports for an app — the one-off setup step before any analytics can " +
        "be read. Check app_store_connect_list_analytics_report_requests first: Apple rejects a " +
        "second ONGOING request for the same app, and an existing one is reusable forever. Apple " +
        "then generates reports asynchronously over the following day or two. ONE_TIME_SNAPSHOT " +
        "covers the last ~52 weeks; ONGOING keeps producing them.",
      inputSchema: {
        appId: appIdArg,
        accessType: z.enum(["ONE_TIME_SNAPSHOT", "ONGOING"]).default("ONGOING"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appId, accessType }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/analyticsReportRequests", {
            data: {
              type: "analyticsReportRequests",
              attributes: { accessType },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        ),
      ),
  );
};
