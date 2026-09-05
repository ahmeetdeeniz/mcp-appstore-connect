# Store Prep

Use this as the reusable ChatGPT Skill/instruction for mobile store preparation.

## Trigger

When the user says an app is ready for “store prep”, “App Store prep”, “Google Play prep”, “release prep”, or equivalent, run this workflow.

## Workflow

1. Identify the exact app/repository, bundle ID/package name, target version/build, supported locales, and whether this is a first release or update.
2. Inspect the source repository and live store state before writing copy. Do not invent privacy/compliance facts.
3. The user owns binary upload:
   - iOS: user uploads the IPA/build to App Store Connect/TestFlight.
   - Android: user uploads the AAB to Google Play Console.
4. Use the user’s real app screenshots as the source material. Use Canva to create polished store artwork and required variants. Preserve the real product UI; marketing frames/callouts may be added, but do not fabricate in-app functionality.
5. Write store copy in Turkish and English unless the user requests another locale set. Respect each store’s field limits and avoid keyword stuffing or unsupported claims.
6. App Store Connect MCP:
   - confirm the intended app/version/build;
   - prepare/apply supported metadata and localizations;
   - upload/reorder screenshots;
   - fill supported review details, categories, pricing/free price point and other supported prerequisites;
   - link the correct build;
   - run release doctor/final validation.
7. Google Play MCP:
   - stage changes in a Google Play Edit;
   - prepare/apply localized listing metadata;
   - upload screenshots, icon/feature graphic where appropriate;
   - configure the intended testing track/tester groups when requested;
   - prepare the release without committing it;
   - run release doctor + validate.
8. For privacy, Data Safety, tracking, encryption, age rating, ads, children/family policy, account deletion and similar declarations: derive only what can be verified from source/config/live store state. Ask the user to confirm any material uncertainty before writing the declaration.
9. Stop before the final irreversible store action unless the user explicitly changes this rule:
   - Apple: do not press/execute Submit for Review.
   - Google Play: do not start the closed test, commit/publish the edit, or start a production rollout.
10. Finish with a concise two-store readiness report showing what is complete, what remains manual because of store/API limitations, and exactly which final button/action the user should take.

## Safety defaults

- Read tools may be used freely.
- Prefer staged/dry-run operations before writes.
- Never log, paste into store copy, or commit credentials/secrets.
- Respect MCP confirmation gates; do not bypass them.
- If live store state conflicts with local metadata, reconcile rather than silently overwriting.
