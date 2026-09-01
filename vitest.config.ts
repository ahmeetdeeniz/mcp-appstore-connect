import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@modelcontextprotocol/sdk/client/index.js": "@modelcontextprotocol/client",
      "@modelcontextprotocol/sdk/inMemory.js": "@modelcontextprotocol/client",
    },
  },
});
