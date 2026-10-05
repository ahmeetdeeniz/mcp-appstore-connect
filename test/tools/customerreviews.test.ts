import { describe, expect, it, vi } from "vitest";

import type { Config } from "#/config";

import {
  baseConfig,
  callArgs,
  connect,
  deleteCall,
  jsonResponse,
  payloadOf,
  postCall,
} from "../helpers.js";

describe("customer reviews", () => {
  const APP_ID = "1234567890";

  it("lists newest-first and comma-joins the rating filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID, rating: [1, 2], territory: "FRA" },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/apps/${APP_ID}/customerReviews`);
    // JSON:API takes a comma-joined list here, not repeated keys.
    expect(url.searchParams.get("filter[rating]")).toBe("1,2");
    expect(url.searchParams.get("filter[territory]")).toBe("FRA");
    expect(url.searchParams.get("sort")).toBe("-createdDate");
  });

  it("omits the answered filter entirely when it is not asked for", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.searchParams.has("exists[publishedResponse]")).toBe(false);
    expect(url.searchParams.has("filter[rating]")).toBe(false);
  });

  it("passes answered:false through as the unanswered filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID, answered: false },
    });

    // `compact` drops undefined, not false — a `false` here is a real filter.
    expect(new URL(callArgs(fetchImpl)[0]).searchParams.get("exists[publishedResponse]")).toBe(
      "false",
    );
  });
});

describe("customer review replies", () => {
  const APP_ID = "1234567890";
  const REVIEW_ID = "review-1";
  const writeConfig: Config = { ...baseConfig, allowWrites: true };

  const reply = (body: string): unknown => ({
    data: {
      id: "resp-1",
      type: "customerReviewResponses",
      attributes: { responseBody: body, state: "PUBLISHED" },
    },
  });
  const noReply = (): Response => new Response(JSON.stringify({ errors: [] }), { status: 404 });

  it("puts each sideloaded reply back on the review it answers", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: "r1",
            type: "customerReviews",
            attributes: { rating: 1, body: "Crashes" },
            relationships: { response: { data: { type: "customerReviewResponses", id: "p1" } } },
          },
          { id: "r2", type: "customerReviews", attributes: { rating: 5, body: "Great" } },
        ],
        included: [
          {
            id: "p1",
            type: "customerReviewResponses",
            attributes: { responseBody: "Fixed in 1.2", state: "PUBLISHED" },
          },
        ],
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_customer_reviews",
        arguments: { appId: APP_ID },
      }),
    ) as { data: { id: string; response?: { responseBody: string } }[] };

    expect(new URL(callArgs(fetchImpl)[0]).searchParams.get("include")).toBe("response");
    expect(body.data[0]?.response?.responseBody).toBe("Fixed in 1.2");
    expect(body.data[1]).not.toHaveProperty("response");
  });

  it("refuses to reply without an explicit confirm", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(reply("x")));
    const client = await connect(writeConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_reply_to_customer_review",
      arguments: { reviewId: REVIEW_ID, responseBody: "Thanks!" },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the reply linked to the review", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? jsonResponse(reply("Thanks!")) : noReply(),
    );
    const client = await connect(writeConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_reply_to_customer_review",
        arguments: { reviewId: REVIEW_ID, responseBody: "Thanks!", confirm: true },
      }),
    );

    const post = postCall(fetchImpl, "/v1/customerReviewResponses");
    expect(JSON.parse(String(post?.[1].body))).toEqual({
      data: {
        type: "customerReviewResponses",
        attributes: { responseBody: "Thanks!" },
        relationships: { review: { data: { type: "customerReviews", id: REVIEW_ID } } },
      },
    });
    expect(body).not.toHaveProperty("replaced");
  });

  /** Apple's POST overwrites an existing reply without a word; the old text must not vanish silently. */
  it("reports the reply it overwrote", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      jsonResponse(init?.method === "POST" ? reply("New text") : reply("Old text")),
    );
    const client = await connect(writeConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_reply_to_customer_review",
        arguments: { reviewId: REVIEW_ID, responseBody: "New text", confirm: true },
      }),
    );

    expect(new URL(callArgs(fetchImpl, 0)[0]).pathname).toBe(
      `/v1/customerReviews/${REVIEW_ID}/response`,
    );
    expect(body.replaced).toBe("Old text");
  });

  it("deletes the review's reply by looking its id up", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : jsonResponse(reply("Bye")),
    );
    const client = await connect(writeConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_delete_customer_review_response",
        arguments: { reviewId: REVIEW_ID, confirm: true },
      }),
    );

    expect(new URL(deleteCall(fetchImpl)?.[0] ?? "").pathname).toBe(
      "/v1/customerReviewResponses/resp-1",
    );
    expect(body.deleted).toBe("Bye");
  });

  it.each([
    ["a 404", noReply],
    ["data: null", () => jsonResponse({ data: null })],
  ])("deletes nothing when the review has no reply (%s)", async (_label, answer) => {
    const fetchImpl = vi.fn(async () => answer());
    const client = await connect(writeConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_delete_customer_review_response",
        arguments: { reviewId: REVIEW_ID, confirm: true },
      }),
    );

    expect(body.deleted).toBeNull();
    expect(deleteCall(fetchImpl)).toBeUndefined();
  });
});
