# App Store Connect metrics: which report holds what, and the traps that bite

Two entirely separate pipelines answer "how is the app doing", and they disagree
with each other on purpose. Pick the right one before pulling anything.

|          | Sales and Trends                                   | Analytics Reports                                       |
| -------- | -------------------------------------------------- | ------------------------------------------------------- |
| Tools    | `download_sales_report`, `download_finance_report` | the five `analytics_report*` tools                      |
| Needs    | `APP_STORE_CONNECT_VENDOR_NUMBER`                  | nothing extra                                           |
| Setup    | none, works immediately                            | a report request, then a day or two of waiting          |
| Shape    | one TSV per date + frequency                       | a request → report → instance → segment walk            |
| Good for | units, money, what you were paid                   | the funnel: impressions, page views, sources, retention |
| Lag      | ~24–48h                                            | longer, and the first instance can take days            |

The rule of thumb: **money questions go to Sales and Trends, discovery
questions go to Analytics.** Downloads exist in both and the two will not match
— see "Why the numbers disagree" below, which is the question that always comes
back from the user.

## Analytics: the reports that matter for marketing

Report names are what `list_analytics_reports` returns and what `filter[name]`
takes. Each has a Standard and a Detailed variant; Detailed adds `Source Info`,
`Page Title` and `Campaign`, and is what you need to attribute anything to a
specific referrer or campaign token.

| Report                                | Category               | Holds                                                                               |
| ------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| App Store Discovery and Engagement    | `APP_STORE_ENGAGEMENT` | impressions and product page views, by source and page type — the top of the funnel |
| App Store Downloads                   | `COMMERCE`             | downloads split by first-time / redownload / update, attributed to source           |
| App Store Purchases                   | `COMMERCE`             | paid app and IAP revenue, attributed to download source and page type               |
| App Store Installations and Deletions | `APP_USAGE`            | installs and deletions per device, with `App Download Date` for cohorting           |
| App Sessions                          | `APP_USAGE`            | how often people open the app and for how long                                      |
| App Store Pre-Order                   | `COMMERCE`             | pre-orders, only relevant around a launch                                           |

The columns are nearly uniform across all of them, which is what makes
`report_stats.py group` work the same way on each:

- `Date` — for weekly and monthly instances this is the **first day** of the
  period, not the last.
- `Counts` — the measure. This is the column you sum.
- `Unique Counts` / `Unique Devices` — deliberately **not** additive. The same
  device appears under several rows, so a sum is an upper bound, never a user
  count. The script flags this rather than letting it be quoted as "users".
- `Source Type` — App Store Search, App Store Browse, Web Referrer, App Referrer,
  Institutional Purchase, Unavailable. This is the single most useful dimension
  in the whole system: it separates "people found us in search" from "our
  website sent them".
- `Page Type` — Product page, Store sheet, No page, In-app event page.
- `Event` / `Download Type` / `Engagement Type` — the row's kind.
- `Territory`, `Device`, `Platform Version`, `App Version`.

### The funnel lives in rows, not columns

The most common mistake is looking for an "impressions" column. There isn't one.
In the Discovery and Engagement report the funnel stages are **values of the
`Event` column**, all measured in `Counts`:

```
group --by Event                                    # Impression vs Page view
group --by "Source Type" --where "Event=Impression" # where impressions come from
group --by "Source Type" --where "Event=Page view"  # where page views come from
```

Conversion is then a division you do yourself: downloads ÷ impressions, from two
different reports over the same window. Apple's own "conversion rate" in the App
Analytics web UI is computed this way too, so a small discrepancy is expected;
state the window and the two source reports rather than quoting a bare
percentage.

### Instances and granularity

An instance is one (granularity, processing date) pair. `DAILY` instances hold a
single day, so a 30-day view means either 30 downloads or one `MONTHLY`
instance. Prefer the coarsest granularity that answers the question — the
segments get large fast, and `download_analytics_report_segment` refuses
anything over 25 MiB compressed by default.

Late-arriving data is real: Apple reissues instances as corrections, so an
instance you read last week can legitimately hold different numbers today. If a
figure moved and nothing else explains it, that is usually why.

## Sales and Trends: the money

`download_sales_report` takes a `reportType` and `reportSubType`. The ones worth
knowing:

- `SALES` + `SUMMARY` — the default. Units and per-unit money per territory.
- `SALES` + `DETAILED` — adds granularity but gets big; watch for truncation.
- `INSTALLS` + `SUMMARY_INSTALL_TYPE` — installs broken out by how they happened.
- `SUBSCRIPTION` / `SUBSCRIBER` / `SUBSCRIPTION_EVENT` — auto-renewable
  subscriptions. The MCP server has no subscription _management_ tools, but
  these reports still read fine.

Date keying is strict and silently wrong if you get it off: `DAILY` wants
`YYYY-MM-DD`, `WEEKLY` wants the **week-ending Sunday**, `MONTHLY` wants
`YYYY-MM`, `YEARLY` wants `YYYY`.

### Three traps in the money columns

**`Developer Proceeds` and `Customer Price` are per unit, not per row.** A row
saying `Units 120, Developer Proceeds 3.49` means 120 × 3.49, not 3.49. Summing
the column straight understates a good month by two orders of magnitude.
`report_stats.py money` does the weighting and labels what it did.

**Currencies do not add up.** `Customer Currency` is what the buyer paid in;
`Currency of Proceeds` is what Apple pays you in for that region. A total across
territories is meaningless without conversion, and Apple does not supply the
rate. The `money` command splits by currency and refuses to combine them. When a
single consolidated figure is genuinely needed, that is what
`download_finance_report` is for — it is the authoritative record of what was
actually paid, per fiscal month and region.

**`Units` mixes purchases with free updates.** `Product Type Identifier`
separates them, and **the first thing to do is list the distinct values in the
file** — `summary` reports them under `groupable`. Apple adds codes, and the
platform decides whether the digit leads or trails, so reading the actual values
beats reasoning from any table including this one:

| Code                   | Means                                               |
| ---------------------- | --------------------------------------------------- |
| `1F` / `7F`            | iOS: first-time download / update (digit first)     |
| `F1` / `F7`            | macOS: first-time download / update (`F` first)     |
| `F3`                   | macOS redownload — neither a new user nor an update |
| `IA1` (`IA1-M` on Mac) | in-app purchase                                     |

The `1`-versus-`7` digit is the part that matters: `1` is a first-time download or
purchase, `7` is a free update. Everything else is platform decoration. A version
release floods the report with `7` rows, so an unfiltered unit count spikes on
release day and looks like a sales surge — it is the existing base updating. Split
by `Product Type Identifier` before quoting units, and quote the `1` rows when the
question is acquisition.

## Why the numbers disagree

Expect this question and answer it before it is asked:

- **Different populations.** Analytics only counts users who agreed to share
  data with developers; Sales and Trends counts every transaction. Analytics
  totals are therefore structurally lower and are a _sample_, not a census.
- **Different events.** Sales `Units` counts a purchase or first download;
  Analytics `App Store Downloads` splits first-time from redownloads and
  updates. Neither is wrong, they measure different things.
- **Different clocks.** Sales reports key on Apple's fiscal calendar and the
  report date; analytics instances key on a processing date. A "week" is not the
  same week.

Say which report a number came from every time. Two numbers that disagree are
fine when each is labelled; the failure is presenting one unlabelled figure as
"downloads".

## Customer reviews

`list_customer_reviews` returns **written** reviews only — rating, title, body,
territory, date. Most people who rate never write anything, and Apple exposes no
aggregate star average through this API at all. So:

- A distribution computed from these is directional, not the App Store rating.
  Never present it as "the app's rating".
- Volume and recency are the useful signals: a cluster of 1-stars in one week,
  or all complaints coming from one territory, is real information.
- `filter[rating]=[1,2]` plus `sort=-createdDate` is the fastest read on what is
  currently going wrong.
- Correlate the date of a cluster against release dates. A rating cliff that
  starts the day a version shipped is the most actionable thing in this whole
  document.

## Preconditions that will stop you

**Analytics needs a report request that may not exist.** Check
`list_analytics_report_requests` first. If there is none, creating one needs
`create_analytics_report_request`, which is a **write** tool — it only exists
when the server runs with `APP_STORE_CONNECT_ALLOW_WRITES=1`. If you cannot see
it, that is the reason; say so and let the user opt in rather than reporting the
analysis as failed. Then Apple needs a day or two before the first instance
appears, so the first run of this skill on a new app returns no analytics at
all. Fall back to Sales and Trends and say what is pending.

The `accessType` matters more than it looks. `ONGOING` accumulates from the
moment it is created and backfills nothing; `ONE_TIME_SNAPSHOT` reaches back
roughly 52 weeks. On an app that has already shipped releases, only the snapshot
can produce a funnel for any of them, and its window keeps rolling forward — a
launch older than ~52 weeks is gone for good. Propose both on a first run.

**A sales report is account-wide.** It holds every app the vendor ships, keyed
by `SKU` / `Title` / `Apple Identifier`. There is no per-app filter on Apple's
side — `/v1/salesReports` takes no app parameter — so the split has to happen
after download. Use `report_stats.py --where "Apple Identifier=<APP_ID>"` on
every command. An unfiltered total is the whole portfolio and looks identical to
a single app's.

**The vendor number cannot be discovered from the API.** There is no vendor
resource in the App Store Connect API at all, so no tool can look one up for
you. Two places to get it: Payments and Financial Reports in App Store Connect,
or the filename of any report already downloaded from there, which embeds it as
`S_<frequency>_<vendorNumber>_<date>.txt`. Note also that Apple answers a vendor
number the key cannot read with a bare HTTP 500 `UNEXPECTED_ERROR`, identical to
a real outage — the MCP server rewrites that to name the vendor number as the
likely cause, but it stays ambiguous, so retry once before believing either
diagnosis.

**Start a sales pipeline with `app_store_connect_get_vendor_number`.** It cannot
discover a number, but it reports the one configured, which layer supplied it
(environment or config file), and whether Apple actually accepts it — one call
that separates "not configured", "configured but wrong", and "configured and
working" before you spend four report downloads finding out. Pass a candidate as
`vendorNumber` to test one without saving it.

**Sales reports need a vendor number.** They fail with "A vendor number is
required" unless one is set — `APP_STORE_CONNECT_VENDOR_NUMBER` in the MCP
server environment, or a `vendorNumber` key in
`~/.config/appstore-connect/config.json`, which is the better place for it since
`.mcp.json` files are usually tracked by git. If it is unset, say the revenue
data was unavailable and why — do not quietly substitute analytics downloads for
sales and call it revenue.

**An empty report arrives as a 404, and it is not an error.** For a period with
no activity — including dates before the app shipped — Apple answers
`/v1/salesReports` with **HTTP 404**, `NOT_FOUND`, "There were no sales for the
date specified". So the tool call fails rather than returning zero rows, and that
failure is data. Check the app's release date before concluding that downloads
collapsed.

The trap is that the same 404 is returned for a period Apple has not generated
yet, and "no sales" and "not computed yet" mean opposite things. Weekly and
monthly reports are assembled after the dailies, so a just-ended week can 404
while every day inside it has sales. **Resolve it by dropping a granularity:**
ask for DAILY reports spanning the same period. Sales in the dailies prove the
coarser report is a lag artifact and must not be reported as a zero period; empty
dailies confirm a real zero. On a multi-app vendor account this is quick to check
— a 404 for a whole account that ships several apps is implausible on its face
and should be treated as lag until the dailies say otherwise.
