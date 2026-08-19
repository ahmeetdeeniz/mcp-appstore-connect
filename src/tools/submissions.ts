import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import {
  type Rec,
  attributesOf,
  isRecord,
  relatedId,
  resourceOf,
  resourcesOf,
  summarizeResponse,
} from "../client/shape.js";
import {
  PLATFORMS,
  PreconditionError,
  appIdArg,
  compact,
  confirmArg,
  limitArg,
  versionIdArg,
  wrap,
} from "./util.js";

const SUBMISSION_STATES = [
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "UNRESOLVED_ISSUES",
  "CANCELING",
  "COMPLETING",
  "COMPLETE",
] as const;

/**
 * A submission Apple has not been handed yet: still a draft, so a version can be
 * added to it and it can be submitted. There is at most one per app+platform.
 */
const DRAFT_STATE = "READY_FOR_REVIEW";

/** States that mean this app already has a submission with Apple. */
const IN_FLIGHT_STATES = ["WAITING_FOR_REVIEW", "IN_REVIEW", "CANCELING", "COMPLETING"];

/**
 * Apple reviewed this submission and handed it back rejected. Deliberately *not*
 * an in-flight state: the submission is the developer's again, and the way back
 * into the queue is to resolve the rejected items and submit the same submission
 * a second time — which is what App Store Connect's "Update review" then
 * "Resubmit to App Review" buttons do.
 *
 * Cancelling one instead is the expensive mistake this constant exists to
 * prevent. A cancel cannot be undone, it surrenders the queue position, and it
 * drags every *other* item out with it — an in-app purchase that Apple had
 * already started reviewing alongside the rejected version goes back to the end
 * of the line with it.
 */
const RETURNED_STATE = "UNRESOLVED_ISSUES";

/** The per-item state that a resubmission has to clear before Apple accepts it. */
const REJECTED_ITEM_STATE = "REJECTED";

/**
 * Version states Apple still accepts into a review submission. The rejected ones
 * are editable again after review, so resubmitting them is the normal path back.
 */
const SUBMITTABLE_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
];

const submissionIdArg = z
  .string()
  .min(1)
  .describe("The reviewSubmission id (from app_store_connect_list_review_submissions).");

/**
 * `summarizeResponse` drops relationships, which for a submission throws away the
 * one thing that identifies it — which version is being reviewed. Keep that id.
 */
const summarizeSubmissions = (response: unknown): unknown => ({
  data: resourcesOf(response).map((res) => ({
    id: res.id,
    type: res.type,
    ...attributesOf(res),
    appStoreVersionForReview: relatedId(res, "appStoreVersionForReview"),
  })),
});

/**
 * Whether this version is already an item on the submission. Apple 409s on a
 * duplicate item, and a re-run after a half-finished submit is exactly when that
 * happens, so we look before adding rather than guessing from the error.
 */
const containsVersion = (itemsResponse: unknown, versionId: string): boolean => {
  const viaRelationship = resourcesOf(itemsResponse).some(
    (item) => relatedId(item, "appStoreVersion") === versionId,
  );
  if (viaRelationship) return true;
  // Some responses carry the link only as a sideloaded resource.
  const included =
    isRecord(itemsResponse) && Array.isArray(itemsResponse.included) ? itemsResponse.included : [];
  return included.some(
    (res) => isRecord(res) && res.type === "appStoreVersions" && res.id === versionId,
  );
};

/**
 * Read the version and report every reason it cannot be submitted at once. Apple
 * answers an unsubmittable version with a generic error that names no cause, and
 * a caller with two problems should learn both in one round trip.
 */
const assertSubmittable = (versionResponse: unknown): { appId: string; platform: string } => {
  const version = resourceOf(versionResponse);
  const attrs = attributesOf(version);
  const appStoreState = attrs.appStoreState;
  const platform = attrs.platform;
  const appId = relatedId(version, "app");
  const buildId = relatedId(version, "build");

  const problems: string[] = [];

  if (typeof appStoreState === "string" && !SUBMITTABLE_STATES.includes(appStoreState)) {
    problems.push(
      `the version is ${appStoreState}; it can only be submitted while it is ` +
        `${SUBMITTABLE_STATES.join(", ")}`,
    );
  }

  if (buildId === undefined) {
    problems.push(
      "no build is attached; attach one with app_store_connect_set_version_build before submitting",
    );
  }

  if (appId === undefined) {
    problems.push(
      "the version response carries no app relationship, so the app it belongs to cannot be " +
        "determined — this is a bug in this tool, not something you can fix in App Store Connect",
    );
  }

  if (typeof platform !== "string") {
    problems.push("the version response carries no platform — cannot open a review submission");
  }

  if (problems.length > 0) {
    throw new PreconditionError(`Cannot submit this version: ${problems.join("; ")}.`, {
      appStoreState,
      versionString: attrs.versionString,
      platform,
      appId,
      buildId,
    });
  }

  return { appId: appId as string, platform: platform as string };
};

export const registerSubmissionTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_review_submissions",
    {
      description:
        "List an app's App Store review submissions and their state (READY_FOR_REVIEW is a draft " +
        "not yet sent to Apple; WAITING_FOR_REVIEW and IN_REVIEW are with Apple). Each row " +
        "carries the id of the version under review.",
      inputSchema: {
        appId: appIdArg,
        platform: z.enum(PLATFORMS).optional().describe("Filter by platform."),
        state: z.enum(SUBMISSION_STATES).optional().describe("Filter by submission state."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, platform, state, limit }) =>
      wrap(async () =>
        summarizeSubmissions(
          await client.get(
            `/v1/apps/${appId}/reviewSubmissions`,
            compact({
              "filter[platform]": platform,
              "filter[state]": state,
              include: "appStoreVersionForReview",
              limit,
            }),
          ),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_submit_version_for_review",
    {
      description:
        "Submit an App Store version to Apple for review — the final step of a release. Creates " +
        "(or reuses) the app's draft review submission, adds the version to it, and submits it. " +
        "The version must be in a submittable state with a build attached; everything Apple " +
        "requires (metadata, screenshots, age rating, review details) must already be in place. " +
        "Also handles resubmitting after a rejection: when the app's submission came back " +
        "UNRESOLVED_ISSUES, this resolves the rejected items and sends that same submission " +
        "back, which keeps its queue position and leaves any in-app purchase already under " +
        "review where it is. Do NOT cancel a rejected submission to start a clean one. " +
        "Once submitted the version is with Apple — use " +
        "app_store_connect_cancel_review_submission to withdraw it.",
      inputSchema: { versionId: versionIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ versionId }) =>
      wrap(async () => {
        // `app` must be included explicitly: unlike `build`, Apple omits that
        // relationship entirely from a bare GET, so the app id is not derivable
        // without it.
        const { appId, platform } = assertSubmittable(
          await client.get(`/v1/appStoreVersions/${versionId}`, { include: "app,build" }),
        );

        // A rejection comes back as a submission the developer owns again, and
        // it is the same submission that goes back to Apple. Handled before the
        // in-flight check below, because it is neither in flight nor a draft:
        // creating a fresh submission alongside it is what Apple 409s on, with
        // an error that blames the *version* ("Version is not ready to be
        // submitted yet") and never mentions the submission holding it.
        const returned = resourcesOf(
          await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
            "filter[platform]": platform,
            "filter[state]": RETURNED_STATE,
            include: "appStoreVersionForReview",
            limit: 10,
          }),
        );
        if (returned.length > 0) {
          const submission = returned[0] as Rec;
          const submissionId = submission.id as string;

          // Apple allows one submission per app+platform, so a returned one all
          // but certainly holds this version — but resubmitting somebody else's
          // version because the ids happened not to match is not a mistake worth
          // risking silently.
          const under = relatedId(submission, "appStoreVersionForReview");
          if (under !== undefined && under !== versionId) {
            throw new PreconditionError(
              `This app has a rejected review submission for a different version (${under}). ` +
                `Resolve or cancel that one before submitting ${versionId}.`,
              { submissionId, versionUnderReview: under },
            );
          }

          const items = resourcesOf(
            await client.get(`/v1/reviewSubmissions/${submissionId}/items`, {
              include: "appStoreVersion",
              limit: 50,
            }),
          );

          // Only the rejected items are touched. The others are still
          // READY_FOR_REVIEW from the first submission and go back untouched —
          // that is how an in-app purchase keeps the review it had already
          // started rather than beginning again.
          const rejected = items.filter((item) => attributesOf(item).state === REJECTED_ITEM_STATE);
          for (const item of rejected) {
            await client.patch(`/v1/reviewSubmissionItems/${String(item.id)}`, {
              data: {
                type: "reviewSubmissionItems",
                id: String(item.id),
                attributes: { resolved: true },
              },
            });
          }

          const resubmitted = await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
            data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } },
          });

          return {
            submissionId,
            versionId,
            resubmitted: true,
            resolvedItems: rejected.length,
            submission: summarizeResponse(resubmitted),
          };
        }

        // One submission per app+platform: an in-flight one has to be cancelled
        // (or finish) before Apple will accept another.
        const inFlight = resourcesOf(
          await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
            "filter[platform]": platform,
            "filter[state]": IN_FLIGHT_STATES,
            limit: 10,
          }),
        );
        if (inFlight.length > 0) {
          const current = inFlight[0] as Rec;
          throw new PreconditionError(
            `This app already has a review submission with Apple (state ` +
              `${String(attributesOf(current).state)}). Wait for it to finish, or withdraw it ` +
              `with app_store_connect_cancel_review_submission.`,
            { submissionId: current.id, state: attributesOf(current).state },
          );
        }

        const drafts = resourcesOf(
          await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
            "filter[platform]": platform,
            "filter[state]": DRAFT_STATE,
            limit: 10,
          }),
        );
        const draft = drafts[0];
        const reusedDraft = draft !== undefined;

        const submissionId =
          typeof draft?.id === "string"
            ? draft.id
            : (resourceOf(
                await client.post("/v1/reviewSubmissions", {
                  data: {
                    type: "reviewSubmissions",
                    attributes: { platform },
                    relationships: { app: { data: { type: "apps", id: appId } } },
                  },
                }),
              ).id as string);

        const alreadyAdded =
          reusedDraft &&
          containsVersion(
            await client.get(`/v1/reviewSubmissions/${submissionId}/items`, {
              include: "appStoreVersion",
              limit: 50,
            }),
            versionId,
          );

        if (!alreadyAdded) {
          await client.post("/v1/reviewSubmissionItems", {
            data: {
              type: "reviewSubmissionItems",
              relationships: {
                reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
                appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
              },
            },
          });
        }

        const submitted = await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
          data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } },
        });

        return {
          submissionId,
          versionId,
          reusedDraft,
          addedItem: !alreadyAdded,
          submission: summarizeResponse(submitted),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_cancel_review_submission",
    {
      description:
        "Withdraw a review submission from Apple, returning its versions to an editable state. " +
        "Only works while the submission is still with Apple and has not started completing; a " +
        "cancelled submission cannot be un-cancelled — submit again to re-enter the queue. " +
        "This is the wrong tool for a rejection: a submission in UNRESOLVED_ISSUES is already " +
        "yours to edit, and app_store_connect_submit_version_for_review sends it back without " +
        "losing the queue position or restarting the review of any in-app purchase attached " +
        "to it.",
      inputSchema: { submissionId: submissionIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ submissionId }) =>
      wrap(async () =>
        summarizeResponse(
          await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
            data: { type: "reviewSubmissions", id: submissionId, attributes: { canceled: true } },
          }),
        ),
      ),
  );
};
