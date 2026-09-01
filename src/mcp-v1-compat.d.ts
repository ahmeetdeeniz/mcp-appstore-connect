declare module "@modelcontextprotocol/sdk/server/mcp.js" {
  import type { ZodTypeAny, infer as ZodInfer } from "zod";

  type RawShape = Record<string, ZodTypeAny>;
  type Args<T extends RawShape> = { [K in keyof T]: ZodInfer<T[K]> };

  export class McpServer {
    registerTool<T extends RawShape>(
      name: string,
      options: {
        inputSchema: T;
        [key: string]: unknown;
      },
      handler: (args: Args<T>, ...rest: unknown[]) => unknown,
    ): unknown;
  }
}

declare module "@modelcontextprotocol/sdk/client/index.js" {
  export { Client } from "@modelcontextprotocol/client";
}

declare module "@modelcontextprotocol/sdk/inMemory.js" {
  export { InMemoryTransport } from "@modelcontextprotocol/client";
}
