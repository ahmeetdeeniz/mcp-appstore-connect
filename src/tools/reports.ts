import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { downloadOrEmpty, emptyFinancePeriod, emptySalesPeriod } from "#/reports/empty";
import { FREQUENCIES } from "#/reports/period";
import { filterSalesReport, salesFilterNote } from "#/reports/salesfilter";
import { contentLineCount, financeCoverage, financeCurrencies, previewReport } from "#/reports/tsv";
import { probeVendor, requireVendor, withVendorHint } from "#/reports/vendor";
import type { ToolContext } from "#/tools/index";
import { compact, type SavedFile, savePathArg, saveToPath, wrap, wrapSaved } from "#/tools/util";

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
 * The argument the three report DOWNLOADS take, described once.
 *
 * Distinct from the terse `savePathArg` every read shares: these write the raw
 * TSV/CSV rather than a JSON envelope, and the completeness guarantee is the
 * whole reason to reach for them, so it is worth the words here.
 */
export const reportSavePathArg = z
  .string()
  .optional()
  .describe(
    "Absolute path to write the report to. The file gets the report in FULL — maxLines then " +
      "only trims the copy inlined in this response — so a saved file is never truncated and " +
      "needs no transcription. Parent directories are created. Use this rather than retyping " +
      "the report into a file, which is where rows go missing.",
  );
/**
 * Write a report where the caller asked, and report what landed.
 *
 * The alternative is the caller retyping the report out of a tool result, and a
 * report is exactly the kind of payload that survives a dropped row looking
 * perfectly well-formed — the totals just come out lower. Writing it here removes
 * the transcription step rather than defending against it.
 *
 * Counts come back with the path so the write can be checked against the same
 * `dataRows` the preview reports, and the two cannot disagree.
 */
const saveReport = async (
  path: string,
  text: string,
): Promise<SavedFile & { lines: number; dataRows: number }> => {
  const written = await saveToPath(path, text, "report");
  const lines = contentLineCount(text.split("\n"));
  return {
    ...written,
    // `report`, not `json`: this file is the raw TSV/CSV Apple returned, and
    // report_stats.py parses it as a table.
    content: "report",
    lines,
    dataRows: Math.max(0, lines - 1),
  };
};
/**
 * Combine the inline preview with the saved-file record.
 *
 * The two describe different things once a file has been written, and the
 * distinction matters downstream: `report_stats.py` treats truncation as a hard
 * error so that a floor is never quoted as a total. Reading the saved file's
 * completeness as a loss would make it refuse a file that lost nothing — which
 * is why `saved.path` is what it follows, and why the note below tells it to.
 */
export const previewAndSave = async (
  text: string,
  maxLines: number,
  savePath: string | undefined,
): Promise<Record<string, unknown>> => {
  const preview = previewReport(text, maxLines);
  if (savePath === undefined) return preview;
  const saved = await saveReport(savePath, text);
  return {
    ...preview,
    saved,
    ...(preview.inlineTruncated === true
      ? {
          savedNote:
            `Read ${saved.path} for any total: it holds all ${saved.dataRows} data rows, while ` +
            `the \`report\` inlined above stops at ${maxLines}. ` +
            `report_stats.py follows this path on its own when handed this result.`,
        }
      : {}),
  };
};
export const registerReportTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "app_store_connect_get_vendor_number",
    {
      title: "App Store Connect: Get Vendor Number",
      description:
        "Report the vendor number the sales and finance report tools will use, where it came " +
        "from, and whether this API key can actually read it. Apple exposes no endpoint that " +
        "returns a vendor number, so this cannot discover one — it reads the configured value " +
        "and verifies it. When none is configured it returns the two places to find one rather " +
        "than failing. Start here when a report tool errors, or when you need to know which " +
        "account the report numbers cover.",
      inputSchema: z.object({
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
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ vendorNumber, verify, savePath }) =>
      wrapSaved(savePath, async () => {
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
      title: "App Store Connect: Download Sales Report",
      description:
        "Download a sales & trends report (units, proceeds) as TSV. Reports lag ~24h and are " +
        "keyed by date: DAILY needs YYYY-MM-DD, WEEKLY the week-ending Sunday, MONTHLY YYYY-MM, " +
        "YEARLY YYYY. Requires a vendor number. The report is account-wide — it holds every app " +
        "the vendor ships, keyed by SKU / Title / Apple Identifier. Apple offers no per-app " +
        "filter, so pass appleIdentifier or sku to have this tool apply one after download — " +
        "otherwise every total spans the whole portfolio. In-app purchase rows carry the IAP's " +
        "own Apple Identifier and name the app only in Parent Identifier, as its SKU, so they " +
        "are kept via that column (see includeInAppPurchases) and the filtered rows can hold " +
        "more than one Apple Identifier. Units mix first-time downloads with free updates (see " +
        "Product Type Identifier), and Developer Proceeds / Customer Price are per unit, not " +
        "per row. A period with no rows comes back as a 404.",
      inputSchema: z.object({
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
        appleIdentifier: z
          .string()
          .optional()
          .describe(
            'Keep only rows whose "Apple Identifier" matches this app id, dropping the rest of ' +
              "the portfolio. Applied before maxLines, so truncation counts this app's rows " +
              "only. This id matches the app's own rows; its in-app purchases are kept through " +
              "Parent Identifier instead — see includeInAppPurchases.",
          ),
        sku: z
          .string()
          .optional()
          .describe(
            'Keep only rows whose "SKU" matches. Combines with appleIdentifier. Also seeds the ' +
              "in-app purchase match, which is worth passing for a period where the app itself " +
              "sold nothing, since the SKU cannot then be read off its own rows.",
          ),
        includeInAppPurchases: z
          .boolean()
          .default(true)
          .describe(
            'Also keep rows whose "Parent Identifier" is this app\'s SKU — its in-app ' +
              "purchases, which carry the IAP's Apple Identifier rather than the app's and are " +
              "therefore invisible to an appleIdentifier filter. Defaults to true: leaving them " +
              "out reports an app with paid IAPs as earning nothing, and the result looks " +
              "entirely well-formed. Set false only to count the app's own units in isolation.",
          ),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe(
            "Truncate the inlined TSV to this many lines. Defaults to 500. Does not affect the " +
              "file written by savePath.",
          ),
        probe: z
          .boolean()
          .default(true)
          .describe(
            "When Apple returns no rows for a period, check a finer granularity before " +
              "answering, so `reason` distinguishes a real zero from a report Apple has not " +
              "assembled yet. Costs nothing on the normal path and nothing when the calendar " +
              "already settles it. Turning it off never produces NO_ROWS — you get UNDETERMINED, " +
              "because an unchecked period is not a zero.",
          ),
        maxProbeDays: z
          .number()
          .int()
          .min(1)
          .max(366)
          .default(31)
          .describe(
            "Cap on sub-periods checked by the probe. Defaults to 31, a full month. Hitting the " +
              "cap yields NO_ROWS_OBSERVED, never NO_ROWS.",
          ),
        savePath: reportSavePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({
      reportDate,
      frequency,
      reportType,
      reportSubType,
      vendorNumber,
      appleIdentifier,
      sku,
      includeInAppPurchases,
      maxLines,
      probe,
      maxProbeDays,
      savePath,
    }) =>
      wrap(async () => {
        const vendor = requireVendor(vendorNumber, ctx.vendorNumber);
        const outcome = await withVendorHint(vendor, () =>
          downloadOrEmpty(
            () =>
              client.downloadReport("/v1/salesReports", {
                "filter[frequency]": frequency,
                "filter[reportType]": reportType,
                "filter[reportSubType]": reportSubType,
                "filter[vendorNumber]": vendor,
                "filter[reportDate]": reportDate,
              }),
            () =>
              emptySalesPeriod(
                frequency,
                reportDate,
                new Date(),
                probe ? { client, vendor, reportType, reportSubType, maxProbeDays } : undefined,
              ),
          ),
        );
        if (typeof outcome !== "string") {
          // No file is written for an empty period. A header-only file would
          // trip report_stats.py's own empty check, relocating the bug rather
          // than answering it.
          return savePath === undefined ? outcome : { ...outcome, saved: null };
        }
        const tsv = outcome;

        if (appleIdentifier === undefined && sku === undefined) {
          return previewAndSave(tsv, maxLines, savePath);
        }

        const filtered = filterSalesReport(tsv, { appleIdentifier, sku, includeInAppPurchases });
        return {
          filter: {
            ...compact({ appleIdentifier, sku }),
            includeInAppPurchases,
            matchedRows: filtered.matchedRows,
            droppedRows: filtered.droppedRows,
            ...(filtered.hasParentColumn
              ? { inAppPurchaseRows: filtered.inAppPurchaseRows, parentSkus: filtered.parentSkus }
              : {}),
            ...compact({ note: salesFilterNote(filtered, sku) }),
          },
          // The saved file is the filtered report, so it is already app-scoped.
          ...(await previewAndSave(filtered.tsv, maxLines, savePath)),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_download_finance_report",
    {
      title: "App Store Connect: Download Finance Report",
      description:
        "Download a financial report (money Apple actually paid, by region) as TSV for one " +
        "fiscal month. This is the authoritative source for proceeds — prefer it over the sales " +
        "report when the question is revenue. Requires a vendor number. " +
        "Each row's amount is in that row's own currency, and regionCode ZZ mixes several: " +
        "never sum amounts across currencies — the response lists them in `currencies` when " +
        "there is more than one. " +
        "reportDate is a FISCAL period, not a calendar one: Apple's fiscal year opens in late " +
        "September and its months are 4-4-5 weeks, so 2026-07 means fiscal month 7 of FY2026 — " +
        "roughly late March to early May — not July. Asking for the wrong period is silent, " +
        "because a well-formed report comes back either way, so read the returned `coverage` " +
        "start and end dates before quoting any number from it. A period with no rows, or one " +
        "Apple has not published yet, comes back as a 404.",
      inputSchema: z.object({
        reportDate: z
          .string()
          .min(1)
          .describe(
            "Fiscal period as YYYY-MM. Fiscal, not calendar — FY2026 opens in late September " +
              "2025, so 2026-07 spans roughly late March to early May 2026. Check `coverage` in " +
              "the response to confirm which dates you actually got.",
          ),
        regionCode: z
          .string()
          .min(1)
          .describe('Financial region code, e.g. "ZZ" for all regions, "US", "EU", "JP".'),
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
          .describe(
            "Truncate the inlined TSV to this many lines. Defaults to 500. Does not affect the " +
              "file written by savePath.",
          ),
        probe: z
          .boolean()
          .default(true)
          .describe(
            "When this region has no rows, retry once against regionCode ZZ (all regions) so the " +
              "answer can distinguish an empty REGION from an empty account. Costs one request, " +
              "and only on the empty path.",
          ),
        savePath: reportSavePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ reportDate, regionCode, vendorNumber, maxLines, probe, savePath }) =>
      wrap(async () => {
        const vendor = requireVendor(vendorNumber, ctx.vendorNumber);
        const outcome = await withVendorHint(vendor, () =>
          downloadOrEmpty(
            () =>
              client.downloadReport("/v1/financeReports", {
                "filter[regionCode]": regionCode,
                "filter[reportType]": "FINANCIAL",
                "filter[vendorNumber]": vendor,
                "filter[reportDate]": reportDate,
              }),
            () =>
              emptyFinancePeriod(reportDate, regionCode, probe ? { client, vendor } : undefined),
          ),
        );
        if (typeof outcome !== "string") {
          return savePath === undefined ? outcome : { ...outcome, saved: null };
        }
        const tsv = outcome;

        // The dates the report covers are in the report, so the fiscal-vs-calendar
        // question is answered from the data rather than from the caller's memory
        // of Apple's calendar.
        const coverage = financeCoverage(tsv);
        const currencies = financeCurrencies(tsv);
        return {
          ...(coverage
            ? { coverage: { ...coverage, requestedFiscalPeriod: reportDate } }
            : {
                coverage: null,
                coverageNote:
                  "This report carries no Start Date / End Date columns, so the fiscal period " +
                  "it covers could not be confirmed from the data. Verify the dates before " +
                  "quoting figures — reportDate is fiscal, not calendar.",
              }),
          ...(currencies.length > 1
            ? {
                currencies,
                currencyNote:
                  `Proceeds in this report are stated in ${currencies.length} currencies ` +
                  `(${currencies.join(", ")}): each row's amount is in its own Partner Share ` +
                  `Currency. Total per currency, or convert first — a sum across rows is not ` +
                  `a revenue figure.`,
              }
            : {}),
          ...(await previewAndSave(tsv, maxLines, savePath)),
        };
      }),
  );
};
