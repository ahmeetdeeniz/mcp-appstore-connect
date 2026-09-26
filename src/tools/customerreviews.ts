import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  type Rec,
  attributesOf,
  includedIndex,
  isRecord,
  relatedId,
  resourceOf,
  resourcesOf,
  summarizeResource,
  summarizeResponse,
} from "#/client/shape";
import {
  appIdArg,
  compact,
  confirmArg,
  getOrNull,
  limitArg,
  savePathArg,
  territoryArg,
  wrap,
  wrapSaved,
} from "#/tools/util";

/** Apple's cap on a developer response, as the web UI enforces it. */
const RESPONSE_MAX_CHARS = 5970;

const reviewIdArg = z
  .string()
  .min(1)
  .describe("The customerReview id (from app_store_connect_list_customer_reviews).");

/**
 * `summarizeResponse` drops `included`, which for a review list is where the
 * replies are: `include=response` sideloads them, and each review only points
 * at its own by id. Put each reply back on the review it answers.
 */
const withResponses = (response: unknown): unknown => {
  const summary = summarizeResponse(response);
  if (!isRecord(summary) || !Array.isArray(summary.data)) return summary;
  const replies = includedIndex(response, "customerReviewResponses");
  const reviews = resourcesOf(response);
  return {
    ...summary,
    data: summary.data.map((row: unknown, index) => {
      const replyId = reviews[index] ? relatedId(reviews[index], "response") : undefined;
      const reply = replyId === undefined ? undefined : replies.get(replyId);
      return reply === undefined || !isRecord(row)
        ? row
        : { ...row, response: summarizeResource(reply) };
    }),
  };
};

/**
 * The reply currently on a review, or `undefined` when there is none. Apple
 * says "none" either as a 404 or as a 200 with `data: null`, depending on
 * whether the review ever had one, so both are read as absent.
 */
const currentReply = async (
  client: AppStoreConnectClient,
  reviewId: string,
): Promise<Rec | undefined> => {
  const reply = resourceOf(await getOrNull(client, `/v1/customerReviews/${reviewId}/response`));
  return typeof reply.id === "string" ? reply : undefined;
};

export const registerCustomerReviewTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_customer_reviews",
    {
      title: "App Store Connect: List Customer Reviews",
      description:
        "List customer reviews for an app — star rating, title, body, nickname, territory and " +
        "date, newest first by default. Filter by rating to read just the 1-star complaints, or " +
        "by territory to see whether a problem is local. A review you have replied to carries " +
        "that reply as `response` (body, state, last modified); a review without one has no " +
        "`response` key. Note these are written reviews only: " +
        "most people rate without writing, and Apple exposes no aggregate star average through " +
        "this API, so a distribution computed from these is directional, not the App Store rating.",
      inputSchema: z.object({
        appId: appIdArg,
        rating: z
          .array(z.number().int().min(1).max(5))
          .optional()
          .describe("Only these star ratings, e.g. [1,2] for the complaints."),
        territory: territoryArg.optional(),
        sort: z
          .enum(["-createdDate", "createdDate", "-rating", "rating"])
          .default("-createdDate")
          .describe("Defaults to newest first."),
        answered: z
          .boolean()
          .optional()
          .describe(
            "true for reviews you have already replied to, false for the unanswered ones. Omit " +
              "for both.",
          ),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, rating, territory, sort, answered, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        withResponses(
          await client.get(
            `/v1/apps/${appId}/customerReviews`,
            compact({
              // buildQuery comma-joins arrays, which is what filter[rating] expects.
              "filter[rating]": rating?.map(String),
              "filter[territory]": territory,
              "exists[publishedResponse]": answered,
              include: "response",
              sort,
              limit,
            }),
          ),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_reply_to_customer_review",
    {
      title: "App Store Connect: Reply to Customer Review",
      description:
        "Publish a developer reply under a customer review on the App Store. The reply is " +
        "public and shows up after a delay, and the reviewer is notified. A review holds one " +
        "reply only, so replying to an answered review OVERWRITES the existing reply: the one " +
        "it replaced is returned as `replaced`. Read the current one first with " +
        "app_store_connect_list_customer_reviews, where it is `response`.",
      inputSchema: z.object({
        reviewId: reviewIdArg,
        responseBody: z
          .string()
          .trim()
          .min(1)
          .max(RESPONSE_MAX_CHARS)
          .describe(
            `The reply text, as customers will read it. At most ${RESPONSE_MAX_CHARS} characters.`,
          ),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ reviewId, responseBody }) =>
      wrap(async () => {
        // Read before writing only to report what gets overwritten: Apple's POST
        // replaces an existing reply silently, and a public reply lost that way
        // cannot be recovered from anywhere else.
        const previous = await currentReply(client, reviewId);
        const created = await client.post("/v1/customerReviewResponses", {
          data: {
            type: "customerReviewResponses",
            attributes: { responseBody },
            relationships: { review: { data: { type: "customerReviews", id: reviewId } } },
          },
        });
        return {
          reviewId,
          ...(summarizeResponse(created) as Rec),
          ...(previous !== undefined ? { replaced: attributesOf(previous).responseBody } : {}),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_customer_review_response",
    {
      title: "App Store Connect: Delete Customer Review Response",
      description:
        "Remove your reply from a customer review. Takes the review id and looks the reply up " +
        "itself; the deleted text is returned as `deleted`. The reply disappears from the App " +
        "Store after a delay. To change a reply, use app_store_connect_reply_to_customer_review " +
        "instead, which overwrites it in place.",
      inputSchema: z.object({ reviewId: reviewIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ reviewId }) =>
      wrap(async () => {
        const reply = await currentReply(client, reviewId);
        if (reply === undefined) {
          return { deleted: null, reviewId, note: "This review has no reply." };
        }
        await client.del(`/v1/customerReviewResponses/${String(reply.id)}`);
        return { deleted: attributesOf(reply).responseBody, responseId: reply.id, reviewId };
      }),
  );
};
