import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { AppStoreConnectClient } from "#/client/asc";
import { createTokenProvider, type Logger, type TokenProvider } from "#/client/auth";
import type { Config } from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-appstore-connect-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the token provider (tests). */
  tokenProvider?: TokenProvider;
};

export type CreatedServer = {
  server: McpServer;
  client: AppStoreConnectClient;
  tokenProvider: TokenProvider;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const tokenProvider =
    opts.tokenProvider ??
    createTokenProvider({
      // Placeholders when unconfigured: the provider is built either way so
      // `createServer` stays total, but no API-calling tool is registered, so
      // it is never actually asked to mint a token.
      credentials: {
        keyId: config.keyId ?? "",
        issuerId: config.issuerId ?? "",
        privateKey: config.privateKey ?? "",
      },
      ttlSeconds: config.tokenTtlSeconds,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });

  const client = new AppStoreConnectClient({
    tokenProvider,
    maxRetries: config.maxRetries,
    userAgent: USER_AGENT,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  registerTools(server, client, {
    config,
    allowWrites: config.allowWrites,
    vendorNumber: config.vendorNumber,
    vendorNumberSource: config.vendorNumberSource,
    metadataRoot: config.metadataRoot,
    contact: config.contact,
  });
  return { server, client, tokenProvider };
};
