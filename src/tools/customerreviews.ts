import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { appIdArg, compact, confirmArg, limitArg, territoryArg, wrap } from "./util.js";

const reviewIdArg = z.string().min(1).describe("Customer review id from app_store_connect_list_customer_reviews.");
const responseIdArg = z.string().min(1).describe("Customer review response id.");

export const registerCustomerReviewTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_customer_reviews",
    {
      description:
        "List customer reviews for an app — star rating, title, body, nickname, territory and date, newest first by default. Filter by rating or unanswered state to build a review-response inbox.",
      inputSchema: {
        appId: appIdArg,
        rating: z.array(z.number().int().min(1).max(5)).optional(),
        territory: territoryArg.optional(),
        sort: z.enum(["-createdDate", "createdDate", "-rating", "rating"]).default("-createdDate"),
        answered: z.boolean().optional(),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, rating, territory, sort, answered, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/customerReviews`,
            compact({
              "filter[rating]": rating?.map(String),
              "filter[territory]": territory,
              "exists[publishedResponse]": answered,
              sort,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_customer_review",
    {
      description: "Get one App Store customer review and include its current developer response when present.",
      inputSchema: { reviewId: reviewIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ reviewId }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/customerReviews/${reviewId}`, { include: "response" }),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_respond_to_customer_review",
    {
      description:
        "Create or update the public developer response to a customer review. This is an idempotent upsert: an existing response is edited instead of creating a duplicate.",
      inputSchema: {
        reviewId: reviewIdArg,
        responseBody: z.string().min(1).max(5970),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ reviewId, responseBody }) =>
      wrap(async () => {
        const existing = await client
          .get(`/v1/customerReviews/${reviewId}/response`)
          .catch(() => ({ data: null }));
        const response = existing as { data?: { id?: string } | null };
        if (response.data?.id) {
          const responseId = response.data.id;
          return {
            action: "updated",
            result: summarizeResponse(
              await client.patch(`/v1/customerReviewResponses/${responseId}`, {
                data: {
                  type: "customerReviewResponses",
                  id: responseId,
                  attributes: { responseBody },
                },
              }),
            ),
          };
        }
        return {
          action: "created",
          result: summarizeResponse(
            await client.post("/v1/customerReviewResponses", {
              data: {
                type: "customerReviewResponses",
                attributes: { responseBody },
                relationships: { review: { data: { type: "customerReviews", id: reviewId } } },
              },
            }),
          ),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_customer_review_response",
    {
      description: "Delete a published developer response from an App Store customer review.",
      inputSchema: { responseId: responseIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ responseId }) =>
      wrap(async () => {
        await client.del(`/v1/customerReviewResponses/${responseId}`);
        return { deleted: responseId };
      }),
  );
};
