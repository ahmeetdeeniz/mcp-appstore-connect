#!/usr/bin/env node
/**
 * Keep plugins/appstore-toolkit/.claude-plugin/plugin.json in step with package.json.
 *
 * Two numbers in that manifest have to move when the server is released, and
 * both went stale by being maintained by hand:
 *
 *   - `mcpServers.appstore-connect.args` pinned the server at `^0.15.0`. On a
 *     0.x package a caret pins the MINOR, so that range only ever resolved to
 *     0.15.0 while the package shipped through 0.20.0. Every install ran a
 *     server five minors old, and the failure was invisible until 0.15.0's
 *     config schema rejected a key a later version had added — at which point
 *     the server exited at startup and Claude Code reported CONNECTION_CLOSED
 *     with no indication why.
 *
 *   - `version` drives Claude Code's plugin auto-update. It sat at 0.10.0 while
 *     the skills underneath it changed, so updated skills never reached anyone.
 *
 * Both are the same bug: a number that must change on release, kept by hand, in
 * a file nobody opens during a release. So it is no longer kept by hand. The
 * plugin version tracks the package version exactly.
 *
 * The plugin no longer BUNDLES the server, so the pin is now optional and this
 * script only maintains it if a future manifest brings one back. Bundling it
 * was a third instance of the same bug, arrived at from a new direction: the
 * pin `>=<version>` names the version being published at that very moment, and
 * an npm configured with `min-release-age` (a supply-chain guard that refuses
 * packages younger than N days) can resolve NO version in that range until the
 * guard expires. The plugin's server was then dead for a day after every
 * release, again as a bare CONNECTION_CLOSED. A pin that is correct only after
 * a delay is not a pin worth keeping, and the server is better installed on its
 * own terms — supervised, with credentials somewhere better than a subprocess
 * environment — than spawned per-editor by `npx`.
 *
 * Run by release-it's `after:bump` hook, so it lands in the release commit.
 * `--check` verifies without writing, which is what CI runs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "plugins/appstore-toolkit/.claude-plugin/plugin.json");
const check = process.argv.includes("--check");

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const { version } = read(join(root, "package.json"));
const manifest = read(manifestPath);

// Absent by design: the plugin ships skills only. Its absence must not fail the
// release — but if a manifest ever declares a server again, the pin goes back
// to being maintained here rather than by hand, which is the whole point.
const server = manifest.mcpServers?.["appstore-connect"];
if (server && !server.args?.length) {
  console.error("sync-plugin-manifest: mcpServers['appstore-connect'] has no args.");
  process.exit(1);
}

// The package spec is the last arg: ["-y", "@scope/name@range"].
const spec = server ? server.args[server.args.length - 1] : undefined;
const wantSpec = spec ? `${spec.slice(0, spec.lastIndexOf("@"))}@>=${version}` : undefined;

const drift = [];
if (manifest.version !== version) drift.push(`version ${manifest.version} -> ${version}`);
if (spec && spec !== wantSpec) drift.push(`server pin ${spec} -> ${wantSpec}`);

if (drift.length === 0) {
  console.log(`sync-plugin-manifest: already in sync at ${version}.`);
  process.exit(0);
}

if (check) {
  console.error(
    `sync-plugin-manifest: plugin manifest is out of sync with package.json ${version}:\n` +
      drift.map((line) => `  - ${line}`).join("\n") +
      `\nRun: node scripts/sync-plugin-manifest.mjs`,
  );
  process.exit(1);
}

// Edit the text rather than re-serialising the object. Re-serialising would
// expand `"args": ["-y", "..."]` onto three lines, which oxfmt then reverts —
// so the release commit would carry a formatting churn that `format:check`
// fails on. A targeted replacement keeps the diff to exactly the lines that
// changed, whatever the surrounding style happens to be.
const quoted = (value) => JSON.stringify(value);
let text = readFileSync(manifestPath, "utf8");

if (manifest.version !== version) {
  const before = text;
  text = text.replace(`"version": ${quoted(manifest.version)}`, `"version": ${quoted(version)}`);
  if (text === before) {
    console.error(`sync-plugin-manifest: could not find "version": ${quoted(manifest.version)}.`);
    process.exit(1);
  }
}

if (spec && spec !== wantSpec) {
  const before = text;
  text = text.replace(quoted(spec), quoted(wantSpec));
  if (text === before) {
    console.error(`sync-plugin-manifest: could not find the server spec ${quoted(spec)}.`);
    process.exit(1);
  }
}

writeFileSync(manifestPath, text);
console.log(
  `sync-plugin-manifest: updated to ${version}:\n${drift.map((l) => `  - ${l}`).join("\n")}`,
);
