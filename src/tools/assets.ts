import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type { AppStoreConnectClient } from "../client/asc.js";

// Apple uploads every binary asset the same way — reserve, PUT the bytes to a
// pre-signed URL, commit a checksum, then poll while validation runs
// asynchronously. Only the resource type differs (appScreenshots,
// inAppPurchaseAppStoreReviewScreenshots, appPreviews…). This module holds the
// part that does not vary, so a second asset kind is a path plus a hint rather
// than a second copy of the flow.

/** Apple rejects anything larger well before processing; fail before reserving. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const POLL_INTERVALS_MS = [1000, 2000, 2000, 3000, 5000];

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const attributesOf = (response: unknown): Rec => {
  if (!isRecord(response) || !isRecord(response.data)) return {};
  return isRecord(response.data.attributes) ? response.data.attributes : {};
};

export const idOf = (response: unknown): string | undefined => {
  if (!isRecord(response) || !isRecord(response.data)) return undefined;
  return typeof response.data.id === "string" ? response.data.id : undefined;
};

/**
 * Resolve the image bytes from either a server-side path or inline base64.
 * `filePath` is the realistic input — a model cannot emit a PNG — but this
 * server also ships as a Docker image, where the host paths a caller would
 * naturally reach for do not resolve inside the container.
 *
 * `what` names the asset in every error, so a failure says "review screenshot"
 * rather than always saying "screenshot" regardless of what was being uploaded.
 */
export const readImage = async (
  filePath: string | undefined,
  fileData: string | undefined,
  fileName: string | undefined,
  what = "screenshot",
): Promise<{ bytes: Buffer; name: string }> => {
  if ((filePath === undefined) === (fileData === undefined)) {
    throw new Error(
      "Pass exactly one of `filePath` (a path readable by this server) or `fileData` (base64).",
    );
  }

  const resolved = await (async (): Promise<{ bytes: Buffer; name: string }> => {
    if (fileData !== undefined) {
      if (!fileName) throw new Error("`fileName` is required when passing `fileData`.");
      return { bytes: Buffer.from(fileData, "base64"), name: fileName };
    }

    const path = filePath as string;
    if (!isAbsolute(path)) {
      throw new Error(
        `\`filePath\` must be an absolute path (got "${path}") — this server's working ` +
          `directory is not necessarily yours.`,
      );
    }
    try {
      return { bytes: await readFile(path), name: fileName ?? basename(path) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(
        `Could not read the ${what} at ${path} (${code ?? "unknown error"}). If this MCP ` +
          `server runs in Docker the path must exist INSIDE the container — mount the folder ` +
          `(docker run -v /host/screenshots:/screenshots …) and pass the container path, or ` +
          `send the image as base64 via \`fileData\` instead.`,
        { cause: err },
      );
    }
  })();

  if (resolved.bytes.byteLength === 0) {
    throw new Error(`The ${what} is empty (0 bytes): ${filePath ?? resolved.name}.`);
  }
  if (resolved.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `The ${what} is ${resolved.bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES}-byte ` +
        `limit. Export it at the exact required dimensions rather than oversampling.`,
    );
  }
  return resolved;
};

export const describeStateErrors = (state: Rec): string =>
  (Array.isArray(state.errors) ? state.errors : [])
    .map((e) => (isRecord(e) ? [e.code, e.description].filter(Boolean).join(": ") : String(e)))
    .filter(Boolean)
    .join("; ");

export type PollOptions = {
  /** Collection path the asset lives under, e.g. `/v1/appScreenshots`. */
  resourcePath: string;
  assetId: string;
  waitSeconds: number;
  /** Echoed back on success so the caller sees what landed where. */
  meta: Record<string, unknown>;
  /**
   * Appended to the rejection message. Validation failures are nearly always
   * dimensions or an alpha channel, and the acceptable dimensions depend on the
   * asset kind — which only the caller knows.
   */
  failureHint: string;
  /** Named in the rejection message as the way to clear a failed asset. */
  deleteToolName: string;
  /** Named in the timeout note as the way to read the final state. */
  pollToolName: string;
};

/**
 * Apple validates the image (dimensions, alpha channel) asynchronously, after
 * the bytes are committed — so this is where a wrongly-sized asset fails.
 */
export const pollAssetState = async (
  client: AppStoreConnectClient,
  opts: PollOptions,
): Promise<unknown> => {
  const { resourcePath, assetId, waitSeconds, meta } = opts;
  const deadline = Date.now() + waitSeconds * 1000;
  let tick = 0;

  for (;;) {
    const attrs = attributesOf(await client.get(`${resourcePath}/${assetId}`));
    const assetState = isRecord(attrs.assetDeliveryState) ? attrs.assetDeliveryState : {};
    const state = typeof assetState.state === "string" ? assetState.state : undefined;

    if (state === "COMPLETE") {
      return {
        id: assetId,
        state,
        ...meta,
        ...(attrs.imageAsset !== undefined ? { imageAsset: attrs.imageAsset } : {}),
        ...(Array.isArray(assetState.warnings) && assetState.warnings.length > 0
          ? { warnings: assetState.warnings }
          : {}),
      };
    }

    if (state === "FAILED") {
      const why = describeStateErrors(assetState);
      throw new Error(
        `App Store Connect rejected the image during processing${why ? `: ${why}` : ""}. ` +
          `${opts.failureHint} The failed asset ${assetId} still exists — delete it with ` +
          `${opts.deleteToolName} before retrying.`,
      );
    }

    if (Date.now() >= deadline) {
      // The bytes are committed by now, so this is NOT a failure. Throwing here
      // would read as "upload failed", prompting a retry that duplicates the
      // asset.
      return {
        id: assetId,
        state: state ?? "UNKNOWN",
        stillProcessing: true,
        ...meta,
        note:
          `Still processing after ${waitSeconds}s. The upload itself succeeded — poll ` +
          `${opts.pollToolName} for the final state.`,
      };
    }

    await sleep(POLL_INTERVALS_MS[Math.min(tick, POLL_INTERVALS_MS.length - 1)] as number);
    tick += 1;
  }
};
