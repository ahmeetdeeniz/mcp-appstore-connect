import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { resourceOf, summarizeResponse } from "../client/shape.js";
import { compact, getOrNull, versionIdArg, wrap } from "./util.js";

// App Review Information: who Apple contacts, and how they get into the app.
// The resource does not exist until someone creates it, and a version without
// one is refused at submission with ENTITY_ERROR.RELATIONSHIP.INVALID —
// "The appStoreReviewDetail associated with appStoreVersions <id> was not
// found." That reads as a broken reference rather than as "you never filled in
// the review contact", which is what it means.

const reviewDetailFields = {
  contactFirstName: z.string().optional().describe("First name of the review contact."),
  contactLastName: z.string().optional().describe("Last name of the review contact."),
  contactPhone: z.string().optional().describe("Phone number Apple can reach the contact on."),
  contactEmail: z.string().optional().describe("Email address Apple can reach the contact on."),
  demoAccountName: z
    .string()
    .optional()
    .describe("Username of a working demo account, when the app needs a sign-in to review."),
  demoAccountPassword: z.string().optional().describe("Password for the demo account."),
  demoAccountRequired: z
    .boolean()
    .optional()
    .describe(
      "Whether reviewing the app requires signing in. Set false for an app with no accounts — " +
        "leaving it unset on an app that plainly has a login invites a rejection.",
    ),
  notes: z
    .string()
    .optional()
    .describe(
      "Notes for the reviewer: how to reach the feature being reviewed, what hardware it needs, " +
        "anything that would otherwise look broken. This is where an app whose main feature is " +
        "behind a paywall or a device capability explains itself.",
    ),
};

/**
 * The id of an existing review detail, or undefined when the version has none.
 *
 * Absence arrives two ways and neither is an error: `getOrNull` turns a 404 into
 * null, and a version that never had one answers **200 with `data: null`**. Both
 * mean "create it", and conflating either with a hit sends a PATCH to
 * `/appStoreReviewDetails/undefined`.
 */
const reviewDetailId = (response: unknown): string | undefined => {
  if (response === null) return undefined;
  const id = resourceOf(response).id;
  return typeof id === "string" ? id : undefined;
};

export const registerReviewDetailTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_get_app_store_review_detail",
    {
      description:
        "Get the App Review Information attached to a version: the contact Apple reaches, the " +
        "demo account, and the reviewer notes. A null result means none exists, which blocks " +
        "submission — this is the check for the 'appStoreReviewDetail … was not found' error.",
      inputSchema: { versionId: versionIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ versionId }) =>
      wrap(async () => {
        const response = await getOrNull(
          client,
          `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`,
        );
        // Two spellings of "absent", and only one of them is a 404: a version
        // that never had a review detail answers 200 with `data: null`, so
        // testing the envelope alone would report the empty case as a hit.
        if (reviewDetailId(response) === undefined) {
          return {
            data: null,
            note:
              "This version has no App Review Information, so it cannot be submitted. Create it " +
              "with app_store_connect_set_app_store_review_detail.",
          };
        }
        return summarizeResponse(response);
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_set_app_store_review_detail",
    {
      description:
        "Set the App Review Information for a version, creating it if this is the first time. " +
        "Required before submitting: a version with none is refused, and the error names a " +
        "missing relationship rather than the missing contact details. Only the fields you pass " +
        "are changed on an existing record. The contact is who Apple phones or emails if review " +
        "has a question, so it must be a real person who will answer.",
      inputSchema: { versionId: versionIdArg, ...reviewDetailFields },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ versionId, ...attributes }) =>
      wrap(async () => {
        const existingId = reviewDetailId(
          await getOrNull(client, `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`),
        );

        // PATCH and POST are not interchangeable here: PATCH against a version
        // that has no detail 404s, and POST against one that does 409s with a
        // duplicate-relationship error. Which verb is right is a property of the
        // server's state, not of the caller's intent, so it is resolved here
        // rather than pushed onto whoever is trying to fill in a phone number.
        if (existingId === undefined) {
          return {
            created: true,
            ...(summarizeResponse(
              await client.post("/v1/appStoreReviewDetails", {
                data: {
                  type: "appStoreReviewDetails",
                  attributes: compact(attributes),
                  relationships: {
                    appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
                  },
                },
              }),
            ) as Record<string, unknown>),
          };
        }

        return {
          created: false,
          ...(summarizeResponse(
            await client.patch(`/v1/appStoreReviewDetails/${existingId}`, {
              data: {
                type: "appStoreReviewDetails",
                id: existingId,
                attributes: compact(attributes),
              },
            }),
          ) as Record<string, unknown>),
        };
      }),
  );
};
