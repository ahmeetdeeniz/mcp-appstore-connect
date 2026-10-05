import type { AppStoreConnectClient } from "#/client/asc";
import { AppStoreConnectApiError } from "#/client/errors";

/**
 * Apple answers a vendor number this key cannot read with a bare HTTP 500
 * `UNEXPECTED_ERROR` telling you to contact support. There is no "unknown
 * vendor" code, and no endpoint to look the right number up — the App Store
 * Connect API has no vendor resource at all (683 paths in the 3.2 spec, none of
 * them vendor-shaped). Surfaced raw, that 500 reads as an Apple outage and
 * sends you to the status page instead of to the one field that is wrong.
 */
export const withVendorHint = async <T>(vendor: string, fn: () => Promise<T>): Promise<T> => {
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
export const probeVendor = async (
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
export const requireVendor = (arg: string | undefined, ctxVendor: string | undefined): string => {
  const vendor = arg ?? ctxVendor;
  if (!vendor) {
    throw new Error(
      "A vendor number is required for reports. Set APP_STORE_CONNECT_VENDOR_NUMBER " +
        "(Payments and Financial Reports in App Store Connect) or pass `vendorNumber`.",
    );
  }
  return vendor;
};
