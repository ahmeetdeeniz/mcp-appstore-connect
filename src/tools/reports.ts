import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { AppStoreConnectApiError } from "../client/errors.js";
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

/**
 * Trim a downloaded TSV report so a huge one doesn't blow the context window.
 *
 * Apple terminates both the sales TSV and an analytics CSV segment with a
 * newline, so a naive `split` leaves a phantom empty line at the end. Counting
 * it overstates `rows`, and — the part that actually hurts — can tip a complete
 * report past `maxLines` and flag it `truncated`. That is not a cosmetic error:
 * `report_stats.py` treats truncation as a hard error precisely so a floor is
 * never quoted as a total, so a false flag makes it refuse a file that lost
 * nothing.
 */
const previewReport = (tsv: string, maxLines: number): Record<string, unknown> => {
  const lines = tsv.split("\n");
  let count = lines.length;
  while (count > 0 && lines[count - 1] === "") count -= 1;

  const truncated = count > maxLines;
  return {
    // Content lines with the header included, so this is one more than the
    // number of data rows.
    rows: count,
    // The same count without the header, because `rows` reads as "data rows" to
    // everyone who has not read this function. A caller verifying a transcription
    // against `rows` is off by exactly one and concludes it dropped a row; both
    // are published so neither reading can be wrong. Zero means Apple returned a
    // header and nothing else.
    dataRows: Math.max(0, count - 1),
    truncated,
    ...(truncated ? { note: `Showing first ${maxLines} of ${count} lines.` } : {}),
    // Untruncated output is handed back byte-for-byte. Only the sliced path
    // drops the trailing newline, and there the text is already partial.
    report: truncated ? lines.slice(0, maxLines).join("\n") : tsv,
  };
};

/**
 * Apple answers a vendor number this key cannot read with a bare HTTP 500
 * `UNEXPECTED_ERROR` telling you to contact support. There is no "unknown
 * vendor" code, and no endpoint to look the right number up — the App Store
 * Connect API has no vendor resource at all (683 paths in the 3.2 spec, none of
 * them vendor-shaped). Surfaced raw, that 500 reads as an Apple outage and
 * sends you to the status page instead of to the one field that is wrong.
 */
const withVendorHint = async <T>(vendor: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppStoreConnectApiError && err.status >= 500) {
      throw new AppStoreConnectApiError(
        `Apple returned HTTP ${err.status} for this report. The usual cause is that vendor ` +
          `number ${vendor} is not one this API key can read — Apple does not distinguish a ` +
          `bad vendor number from a server fault here, and exposes no way to list the valid ` +
          `ones. Check Payments and Financial Reports in App Store Connect, or read it out ` +
          `of a previously downloaded report's filename (S_<freq>_<vendorNumber>_<date>.txt). ` +
          `If the number is definitely right, retry — a genuine 5xx looks identical. ` +
          `Original: ${err.message}`,
        { status: err.status, errors: err.errors },
      );
    }
    throw err;
  }
};

/**
 * Apple reports "this period has no rows" as an HTTP 404, so a quiet month and a
 * broken call are the same shape. Left raw it reads as a failure; reported as
 * data it reads as a zero. Both are wrong often enough to matter, because the
 * *same* 404 covers a third case: a period Apple has not assembled yet.
 *
 * Weekly and monthly reports are built after the dailies, so a week that just
 * ended can 404 while every day inside it has sales — and "no sales" versus "not
 * computed yet" are opposite conclusions about the same response. The caller
 * cannot tell them apart from the status code, so the message names the check
 * that can: ask for a finer granularity over the same span.
 */
const withEmptyPeriodHint = async <T>(period: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppStoreConnectApiError && err.status === 404) {
      throw new AppStoreConnectApiError(
        `Apple returned no rows for ${period}. This is how it reports a period with no ` +
          `activity — including dates before the app shipped — so it is an answer, not a ` +
          `fault, and the vendor number and credentials are fine. Before recording a zero, ` +
          `note that Apple returns this same 404 for a period it has not generated yet: ` +
          `weekly and monthly reports are assembled after the dailies, so a recently ended ` +
          `week can 404 while the days inside it have sales. Re-ask at DAILY granularity ` +
          `across the same span — sales in the dailies mean this is reporting lag and must ` +
          `not be reported as zero; empty dailies confirm a real zero. Original: ${err.message}`,
        { status: err.status, errors: err.errors },
      );
    }
    throw err;
  }
};

/**
 * How far back to date the probe report. Sales reports lag ~24h, so "yesterday"
 * is a coin flip on whether Apple has closed the day yet — and a 404 for a day
 * that does not exist yet is indistinguishable from a 404 for a day with no
 * sales. Five days is comfortably inside both the lag and Apple's daily
 * retention window, so the only thing the probe can still fail on is the vendor
 * number itself, which is the whole point.
 */
const PROBE_DAYS_BACK = 5;

const probeDate = (now: Date): string =>
  new Date(now.getTime() - PROBE_DAYS_BACK * 86_400_000).toISOString().slice(0, 10);

type VendorProbe = { readable: boolean; reportDate: string; detail: string };

/**
 * Ask Apple whether this key can actually read this vendor number, by pulling
 * the cheapest report there is and reading the failure mode rather than the
 * body.
 *
 * The signal is inverted from what you would expect: **404 means the vendor
 * number is good.** Apple only reaches "there were no sales for the date
 * specified" after it has accepted and authorised the vendor, so a 404 proves
 * more than a 200 does — it is the answer for a valid vendor on a quiet day,
 * and a brand-new account with zero sales would never verify otherwise.
 *
 * A wrong vendor number surfaces as a bare 5xx (see `withVendorHint`). 401/403
 * are about the key, not the vendor, and a 400 means these probe parameters are
 * wrong — a bug here, not a user error — so both are rethrown rather than
 * reported as a bad vendor number.
 */
const probeVendor = async (
  client: AppStoreConnectClient,
  vendor: string,
  now: Date,
): Promise<VendorProbe> => {
  const reportDate = probeDate(now);
  try {
    await client.downloadReport("/v1/salesReports", {
      "filter[frequency]": "DAILY",
      "filter[reportType]": "SALES",
      "filter[reportSubType]": "SUMMARY",
      "filter[vendorNumber]": vendor,
      "filter[reportDate]": reportDate,
    });
    return { readable: true, reportDate, detail: "Apple returned a sales report for this vendor." };
  } catch (err) {
    if (!(err instanceof AppStoreConnectApiError)) throw err;
    if (err.status === 404) {
      return {
        readable: true,
        reportDate,
        detail:
          "Apple accepted the vendor number and reported no sales on that date, which only " +
          "happens once the vendor has been resolved and authorised.",
      };
    }
    if (err.status >= 500) {
      return {
        readable: false,
        reportDate,
        detail:
          `Apple returned HTTP ${err.status}. It has no "unknown vendor" code and answers a ` +
          `vendor number this key cannot read with a bare server error, so this almost ` +
          `certainly means ${vendor} is wrong or not visible to this key — but a genuine ` +
          `Apple outage looks identical, so retry before changing the setting.`,
      };
    }
    throw err;
  }
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
    "app_store_connect_get_vendor_number",
    {
      description:
        "Report the vendor number the sales and finance report tools will use, where it came " +
        "from, and whether this API key can actually read it. Apple exposes no endpoint that " +
        "returns a vendor number, so this cannot discover one — it reads the configured value " +
        "and verifies it. When none is configured it returns the two places to find one rather " +
        "than failing. Start here when a report tool errors, or when you need to know which " +
        "account the report numbers cover.",
      inputSchema: {
        vendorNumber: z
          .string()
          .optional()
          .describe("Check this candidate instead of the configured value. Nothing is saved."),
        verify: z
          .boolean()
          .default(true)
          .describe(
            "Download one throwaway daily report to confirm Apple accepts the number. " +
              "Set false to read the configuration without calling Apple.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ vendorNumber, verify }) =>
      wrap(async () => {
        const vendor = vendorNumber ?? ctx.vendorNumber;
        if (!vendor) {
          return {
            vendorNumber: null,
            configured: false,
            hint:
              "No vendor number is configured, so the sales and finance report tools will " +
              "fail. There is no API that returns one: read it from Payments and Financial " +
              "Reports in App Store Connect, or from the middle field of a previously " +
              "downloaded report's filename (S_<frequency>_<vendorNumber>_<date>.txt). Then " +
              "set APP_STORE_CONNECT_VENDOR_NUMBER, or add a `vendorNumber` key to the " +
              "config file. Analytics reports need no vendor number and are unaffected.",
          };
        }

        const source = vendorNumber
          ? "argument"
          : // Only absent when the number came from neither loader, which cannot
            // happen for a configured value — but the type allows it, so say so
            // rather than asserting.
            (ctx.vendorNumberSource ?? "unknown");

        if (!verify) {
          return { vendorNumber: vendor, configured: true, source, verified: false };
        }

        const probe = await probeVendor(client, vendor, new Date());
        return {
          vendorNumber: vendor,
          configured: true,
          source,
          verified: true,
          readable: probe.readable,
          probe: { reportDate: probe.reportDate, detail: probe.detail },
          // Every report this vendor number produces spans the whole account, so
          // a per-app number is always a filter away, never the report total.
          scope: "Account-wide: reports cover every app under this vendor, not one app.",
        };
      }),
  );

  server.registerTool(
    "app_store_connect_download_sales_report",
    {
      description:
        "Download a sales & trends report (units, proceeds) as TSV. Reports lag ~24h and are " +
        "keyed by date: DAILY needs YYYY-MM-DD, WEEKLY the week-ending Sunday, MONTHLY YYYY-MM, " +
        "YEARLY YYYY. Requires a vendor number. The report is account-wide — it holds every app " +
        "the vendor ships, keyed by SKU / Title / Apple Identifier, and Apple offers no per-app " +
        "filter, so totals must be filtered to one app after download or they span the whole " +
        "portfolio. Units mix first-time downloads with free updates (see Product Type " +
        "Identifier), and Developer Proceeds / Customer Price are per unit, not per row. A period " +
        "with no rows comes back as a 404.",
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
        const tsv = await withVendorHint(vendor, () =>
          withEmptyPeriodHint(`${frequency} ${reportDate}`, () =>
            client.downloadReport("/v1/salesReports", {
              "filter[frequency]": frequency,
              "filter[reportType]": reportType,
              "filter[reportSubType]": reportSubType,
              "filter[vendorNumber]": vendor,
              "filter[reportDate]": reportDate,
            }),
          ),
        );
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
        const tsv = await withVendorHint(vendor, () =>
          withEmptyPeriodHint(`fiscal ${reportDate} in region ${regionCode}`, () =>
            client.downloadReport("/v1/financeReports", {
              "filter[regionCode]": regionCode,
              "filter[reportType]": "FINANCIAL",
              "filter[vendorNumber]": vendor,
              "filter[reportDate]": reportDate,
            }),
          ),
        );
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
