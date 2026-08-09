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
separates them: codes starting `1` are first-time downloads or purchases, `7` is
an update, `F` prefixes Mac, `IA` prefixes in-app purchases. A version release
floods the report with type-`7` rows, so an unfiltered unit count spikes on
release day and looks like a sales surge. Split by `Product Type Identifier`
before quoting units. Rather than trusting this list, check the distinct values
in the file — Apple adds codes, and `summary` lists them.

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

**Sales reports need a vendor number.** They fail with "A vendor number is
required" unless `APP_STORE_CONNECT_VENDOR_NUMBER` is set in the MCP server
environment. It is found under Payments and Financial Reports in App Store
Connect. If it is unset, say the revenue data was unavailable and why — do not
quietly substitute analytics downloads for sales and call it revenue.

**An empty report is not an error.** Apple returns no rows for a date with no
activity, and for dates before the app shipped. Check the app's release date
before concluding that downloads collapsed.
