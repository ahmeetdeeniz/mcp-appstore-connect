# ChatGPT Store Prep activation checklist

Use this on the day the ChatGPT Business workspace is enabled.

- [ ] Business workspace exists and Developer Mode is enabled.
- [ ] OpenAI Platform tunnel exists with the correct ChatGPT workspace scope.
- [ ] Restricted runtime API key has Tunnels Read + Use only.
- [ ] `tunnel-client` is installed from an OpenAI-supported release.
- [ ] `CONTROL_PLANE_TUNNEL_ID` and `CONTROL_PLANE_API_KEY` are set locally, never committed.
- [ ] App Store Connect API key/config is available locally; `.p8` stays local.
- [ ] `scripts/check-chatgpt-ready.ps1` passes.
- [ ] `scripts/chatgpt-tunnel.ps1` connects read-only and `tunnel-client runtimes status app-store-connect --json` reports ready.
- [ ] ChatGPT custom app is created using Connection: Tunnel and the same tunnel id.
- [ ] Read-only smoke: auth status, app/version/build lookup and release doctor are correct.
- [ ] Reconnect with `scripts/chatgpt-tunnel.ps1 -Writes`.
- [ ] Re-scan tools in ChatGPT; write tools are visible.
- [ ] Dry-run listing/screenshot smoke targets the intended editable version only.
- [ ] Store Prep skill/instructions are installed from `STORE_PREP_SKILL.md`.
- [ ] Canva connector is connected and can create/export the intended store artwork.
- [ ] Final Submit for Review / release actions remain user-controlled.
