# ChatGPT Business readiness

This repository is intentionally kept as a local **stdio MCP server**. ChatGPT Business can reach it through OpenAI Secure MCP Tunnel without exposing this MCP server directly to the public internet.

## Before switching to Business

The repository can be prepared now. The only values that cannot exist until the Business workspace/tunnel is created are:

- `CONTROL_PLANE_TUNNEL_ID`
- `CONTROL_PLANE_API_KEY` (restricted runtime key with Tunnels Read + Use)
- ChatGPT Business workspace scope / connector approval

Do **not** commit any of those values, the App Store Connect `.p8`, inline private-key contents, or any other secret.

## Local prerequisites

- Node.js 22+
- pnpm 11+
- dependencies installed (`pnpm install --frozen-lockfile`)
- build completed (`pnpm build`)
- `tunnel-client` installed from OpenAI's supported release
- App Store Connect credentials available through the existing config/env model

For write tools, explicitly set:

```powershell
$env:APP_STORE_CONNECT_ALLOW_WRITES = "1"
```

Leave it unset for read-only validation.

## First Business connection

After the Business workspace exists, create a tunnel scoped to that workspace in OpenAI Platform Tunnels. Then set the runtime key and connect this stdio server:

```powershell
$env:CONTROL_PLANE_API_KEY = "<runtime key>"
$env:CONTROL_PLANE_TUNNEL_ID = "<tunnel id>"

pnpm install --frozen-lockfile
pnpm build

# Long-lived local runtime managed by tunnel-client.
tunnel-client runtimes connect `
  --alias app-store-connect `
  --tunnel-id $env:CONTROL_PLANE_TUNNEL_ID `
  --runtime-api-key env:CONTROL_PLANE_API_KEY `
  --mcp-command "node $PWD/dist/cli.js"

tunnel-client runtimes status app-store-connect --json
```

Only treat the connector as ready when tunnel-client reports the runtime running and healthy/ready.

Then, in ChatGPT Business, enable Developer Mode, create a custom MCP app, choose **Connection: Tunnel**, and select/paste the same tunnel ID.

## Recommended activation sequence

1. Connect with `APP_STORE_CONNECT_ALLOW_WRITES` unset.
2. Verify `app_store_connect_auth_status`, app lookup and release-doctor reads.
3. Verify the intended App Store Connect app/version/build.
4. Enable `APP_STORE_CONNECT_ALLOW_WRITES=1` and reconnect the local runtime.
5. Re-scan the custom app tools in ChatGPT so write tools become visible.
6. Keep final `Submit for Review` / release actions user-controlled.

## Store Prep workflow

The intended workflow is:

1. User uploads the IPA/build to App Store Connect/TestFlight.
2. ChatGPT inspects the app/repo and writes TR/EN store copy.
3. Canva produces final App Store screenshot artwork.
4. This MCP uploads screenshots, applies metadata/localizations, links the build, fills review details and other supported submission prerequisites.
5. Run release doctor / final validation.
6. Stop before the user's final **Submit for Review** action.

Screenshot upload already supports both a server-readable `filePath` and inline base64 `fileData`, which is useful when artwork comes from another connector rather than a local file.

The server hides mutation tools by default and confirmation-gates destructive or submission-impacting operations.
