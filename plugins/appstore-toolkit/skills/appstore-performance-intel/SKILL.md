---
name: appstore-performance-intel
description: Analyze how a shipped app is actually doing on the App Store — downloads, units, sales and proceeds, impressions, product page views, conversion rate, retention, deletions, and the star ratings behind them — by pulling the real numbers from App Store Connect and writing a dated markdown report. Use this whenever the user asks how their app is performing, what downloads or sales are doing, whether revenue is up or down, why conversion or installs dropped, where their traffic comes from, which territories matter, how a release affected the numbers, or asks for a performance / metrics / downloads / sales / revenue report — including the standing "how did we do last month" check. Reach for it even when the ask is vague or emotional ("did the 2.1 launch work?", "feels like downloads died", "are we growing?"), because the failure mode of answering those from memory is inventing a trend, and the checks that catch that live here. Also use it when a number needs explaining rather than producing — "why do App Store Connect and my analytics disagree", "is that units figure revenue or downloads", "what counts as an impression". This skill measures, diagnoses and recommends store-side actions from what it measured; feature and competitive strategy belong to app-market-intel.
---

# App Store performance intel

This answers one question with real data: **what are the numbers doing, and
why?** It reads App Store Connect, does the arithmetic in a script rather than
by eye, and writes a dated report you can diff against last month's.

The failure modes here are specific and they are why the skill exists. People
quote a truncated report as a total. They sum a per-unit money column and
understate revenue by a hundred times. They add euros to yen. They call a
release-day flood of free updates a sales surge. They report a conversion rate
without saying which two reports it came from. Every one of those produces a
confident number that is simply wrong, and none of them is visible in the
output. Run the numbers through the script, label every figure with its source,
and spend your judgment on what the movement means.

A second failure mode is subtler: **answering from the shape of the question.**
If the user says "downloads died", the answer is not sympathy and a plausible
cause. It is a measurement that either confirms it or doesn't, and quite often
doesn't.

## What this skill does not do

It does not propose features, read competitors, or judge positioning. When the
run surfaces something that needs a product decision, name it and hand off to
`app-market-intel`, which has the ledger of what has already been proposed and
rejected. Two skills inventing roadmap independently is how contradictory advice
gets written.

Recommendations here are allowed, expected, and **bounded**: every one must
trace to a number measured in this run. "Search impressions fell 28% while web
referrals rose — the keyword set is worth re-checking" is in scope. "Add a
widget" is not, no matter how good the idea.

## 1. Resolve the app and the window before pulling anything

Two things have to be pinned or every number afterwards is unattributable.

**The app id.** If the user names a repo or you are in one, the id is on disk —
`Listing/.listing.json` or the metadata sidecar carries it, and
`app-market-intel`'s `audit_release_state.py` extracts it with no network call.
Otherwise `app_store_connect_list_apps` and match the bundle id. Do not guess
between two apps; ask.

**The window, stated as dates.** "Last month" is ambiguous at month boundaries
and "recently" is not a window at all. Resolve it to explicit dates, say them in
the report, and use the same window for every report you pull — a funnel built
from two different windows is not a funnel.

Then get the release dates: `app_store_connect_list_versions` gives version
strings and dates. These are the join that makes the whole report useful. A
metric that moved is interesting; a metric that moved the day 2.1 shipped is an
explanation.

## 2. Pull the numbers

Read `references/asc-metrics.md` first — it holds the report catalogue, the
column semantics, and the traps. Two independent pipelines answer different
questions and they will not agree with each other:

- **Sales and Trends** (`download_sales_report`, `download_finance_report`) —
  units and money. Works immediately, needs a vendor number.
- **Analytics** (the five `analytics_report*` tools) — the funnel: impressions,
  page views, sources, installs, deletions, sessions. Needs a report request
  that may not exist yet.

Start with sales, because it always works:

```
app_store_connect_download_sales_report { reportDate, frequency, reportType: "SALES", maxLines: 5000 }
```

Then the analytics walk. It is four hops and the first one is the one people
skip:

```
app_store_connect_list_analytics_report_requests    { appId }
app_store_connect_list_analytics_reports            { reportRequestId, category }
app_store_connect_list_analytics_report_instances   { reportId, granularity }
app_store_connect_download_analytics_report_segment { instanceId }
```

**If there is no report request, analytics is not merely empty — it has never
been enabled.** Creating one needs `create_analytics_report_request`, a write
tool that only exists when the server runs with
`APP_STORE_CONNECT_ALLOW_WRITES=1`. If you cannot see that tool, that is the
reason; say so and let the user opt in. Even once created, Apple takes a day or
two to produce the first instance, so a first run on a new app legitimately has
no funnel data. Report the sales half and say what is pending — do not present
an empty analytics result as a collapse.

Ratings are cheap and often the most actionable thing in the run:

```
app_store_connect_list_customer_reviews { appId, rating: [1,2], sort: "-createdDate" }
```

These are written reviews only, so treat them as directional signal, never as
"the app's rating". A cluster of 1-stars that starts on a release date is worth
more than the whole rest of the report.

### Save each response to a file as you go

Dump the tool result verbatim — the whole JSON, not just the report text. The
script reads that shape directly, and the `truncated` flag it carries is the one
thing you cannot recover later. A report cut off at `maxLines` still sums to a
plausible number.

## 3. Do the arithmetic in the script, not in your head

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/report_stats.py summary <file>...
python3 ${CLAUDE_SKILL_DIR}/scripts/report_stats.py group   <file> --by "Source Type" --where "Event=Impression"
python3 ${CLAUDE_SKILL_DIR}/scripts/report_stats.py money   <file> --by "Product Type Identifier"
python3 ${CLAUDE_SKILL_DIR}/scripts/report_stats.py compare <previous> <current> --by Territory
```

`summary` first, always. It reports the row count, the real date span, every
numeric total, and which columns are worth grouping by — which means you never
have to guess a column name, and you find out immediately if Apple returned a
different shape than you expected.

The script refuses to work on a truncated file and exits non-zero. That is
deliberate: re-fetch with a higher `maxLines` or a narrower window. Passing
`--allow-truncated` to get past it turns every total in your report into a
floor, and nothing downstream will remind you.

It also encodes three things that are easy to get wrong by hand and that the
`money` command handles for you: per-unit money columns get weighted by units,
currencies are never combined, and free updates are separated from purchases.
Trust its labels over your own mental arithmetic.

**The funnel lives in rows, not columns.** There is no impressions column;
`Impression` and `Page view` are values of `Event`, both measured in `Counts`.
Conversion is a division you do across two reports over the same window — state
both sources when you quote it.

## 4. Explain the movement, don't just report it

A table of numbers is not the deliverable. For anything that moved
meaningfully, work the attribution in this order, stopping when one holds:

1. **A release.** Line the change up against version dates from step 1.
2. **A source shift.** `group --by "Source Type"` on both periods. Search
   falling while referral rises is a different story from everything falling.
3. **A territory.** One market moving can carry a global total; `compare --by
Territory` shows it in one line.
4. **A composition change.** Did units rise because of updates rather than
   purchases? Did a price change move proceeds without moving units?
5. **Apple's own reporting.** Late-arriving corrections, an empty date, a
   changed report shape.

If none of them holds, say the movement is unexplained. An honest "down 19% and
I can't attribute it" is worth more than a confident guess, and it tells the
user where to look next.

Do not assert a cause you did not measure. The tell is a sentence where a
metric's fall is explained by something with no number attached to it.

## 5. Write the report

Write to `<docs-dir>/performance/<YYYY-MM-DD>-performance.md` — alongside
whatever documentation directory the repo already uses, creating it if needed.
When there is no repo, ask where it should go rather than inventing a path.

Use this shape:

```markdown
# <App> — performance, <window as explicit dates>

## Headline

Three or four sentences. What moved, by how much, and the most likely why.

## The numbers

Tables from the script. Every figure labelled with the report it came from.

## Funnel

Impressions → product page views → downloads, with conversion stated as a
division and both sources named. Say when a stage is unavailable.

## What changed and why

The attribution work from step 4, including anything left unexplained.

## Ratings

Volume, recency, and whether a cluster lines up with a release.

## Recommendations

Store-side actions only, each one naming the number it comes from.

## Gaps

What could not be measured and why — no vendor number, no analytics request,
Apple's lag, a window with no data. This section is not optional.
```

Then append one line to `<docs-dir>/performance/ledger.md`: the date, the window
and the headline figure. Next month's run reads it first, which is what turns a
series of snapshots into a trend and stops the same movement being reported as
new three times running.

Do not commit anything unless asked.

## 6. Report back

Give the user the headline and the path. Repeat the Gaps section in the chat —
what you could not measure is the part they most need to see, and it is the part
that gets lost when only a file path is handed over.
