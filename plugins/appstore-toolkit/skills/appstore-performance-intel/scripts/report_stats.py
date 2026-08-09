#!/usr/bin/env python3
"""Aggregate an App Store Connect report into numbers you can quote.

Answers the questions you cannot reliably eyeball from a wall of TSV:
  - How many downloads/impressions/units, in total and broken down by territory,
    source, device or event?
  - What did the money actually come to, without mixing currencies or
    double-counting a per-unit column?
  - What changed between this period and the last one, per row?

Feed it the tool output verbatim. The report tools answer with
{"rows": N, "truncated": bool, "report": "<text>"}, and this reads that JSON
directly as well as a plain .tsv/.csv, so no hand-extraction step is needed --
that step is where the truncation flag usually gets lost.

Truncation is treated as a hard error, not a note. A report cut off at maxLines
still sums to a plausible-looking number, and a floor presented as a total is
the single worst failure mode here. Re-fetch with a higher maxLines (or a
SUMMARY subtype) rather than passing --allow-truncated, which only exists for
deliberately sampling the shape of a file.

Usage:
    python3 report_stats.py summary FILE [FILE ...]
    python3 report_stats.py group   FILE --by COL[,COL] [--metric COL] [--top N]
    python3 report_stats.py money   FILE [--by COL] [--top N]
    python3 report_stats.py compare BASE CURRENT --by COL [--metric COL] [--top N]

This script never makes network calls. Fetch the reports with the
appstore-connect MCP and save what it returns.
"""

import argparse
import json
import re
import sys

# Metric columns worth summing, in the order we would pick one automatically.
# "Counts" is what every Analytics report calls its measure; "Units" is the
# Sales and Trends equivalent. Unique* are deliberately ranked below the raw
# counts: they do not add up across rows (the same device appears in several),
# so a sum of them is only ever an upper bound.
METRIC_PREFERENCE = [
    "Counts",
    "Units",
    "Quantity",
    "Unique Counts",
    "Unique Devices",
]

NON_ADDITIVE = {"Unique Counts", "Unique Devices"}

# Numeric-looking columns that are labels, not measures. "App Apple Identifier"
# is the one that actually shows up, and a summed app id is pure noise.
ID_COLUMN = re.compile(r"\b(identifier|id)\b", re.IGNORECASE)

# Sales and Trends money columns are PER UNIT, not per row. Total spend is
# Units x Customer Price; total proceeds is Units x Developer Proceeds. Summing
# the column straight is the classic mistake and understates a busy day by
# orders of magnitude.
PER_UNIT_PRICE = "Customer Price"
PER_UNIT_PROCEEDS = "Developer Proceeds"
UNITS = "Units"
PRODUCT_TYPE = "Product Type Identifier"

# Which currency each of those is denominated in. They differ: a French sale
# has Customer Price in EUR and Developer Proceeds in whatever Apple pays that
# region in, so the two cannot share a total.
CURRENCY_OF_PRICE = "Customer Currency"
CURRENCY_OF_PROCEEDS = "Currency of Proceeds"


class ReportError(Exception):
    """Something about the input makes the requested number unanswerable."""


def read_report(path):
    """Return (rows, columns, truncated, note) from a tool dump or a raw file."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        raw = fh.read()

    truncated = False
    note = ""
    text = raw.strip()

    # The tool result shape: {"rows": N, "truncated": bool, "report": "..."}.
    # Also tolerate the segment-download shape, which nests the same keys
    # alongside a "segment" block.
    if text.startswith("{"):
        try:
            blob = json.loads(text)
        except json.JSONDecodeError:
            blob = None
        if isinstance(blob, dict):
            if "error" in blob and "report" not in blob:
                raise ReportError(
                    "This file holds a tool ERROR, not a report: %s" % blob.get("error")
                )
            if "report" not in blob:
                raise ReportError(
                    "JSON input has no 'report' key. Save the whole tool result, "
                    "or save the raw TSV/CSV text."
                )
            truncated = bool(blob.get("truncated"))
            note = str(blob.get("note") or "")
            text = blob["report"]

    lines = [ln for ln in text.split("\n") if ln.strip()]
    if not lines:
        raise ReportError("The report is empty -- Apple returned no rows for that query.")

    delimiter = "\t" if lines[0].count("\t") >= lines[0].count(",") else ","
    columns = [c.strip() for c in lines[0].split(delimiter)]
    rows = []
    for line in lines[1:]:
        cells = line.split(delimiter)
        # Ragged rows happen when a free-text field contains the delimiter.
        # Pad rather than drop: the metric columns are positional and early.
        if len(cells) < len(columns):
            cells += [""] * (len(columns) - len(cells))
        rows.append({col: cells[i].strip() for i, col in enumerate(columns)})

    return rows, columns, truncated, note


def to_number(value):
    """Parse a report cell as a number, or None when it is not one."""
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if not text or text in {"-", "--"}:
        return None
    # Apple writes negative money as (1.23) in some finance reports.
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    text = re.sub(r"^[^\d.\-]+", "", text)
    try:
        number = float(text)
    except ValueError:
        return None
    return -number if negative else number


def numeric_columns(rows, columns):
    """Columns where most non-empty cells parse as numbers and a sum means something.

    Identifiers parse as numbers but adding them up is noise, and so is any
    column holding one repeated value -- both are excluded so the summary shows
    only totals worth reading.
    """
    found = []
    for col in columns:
        if ID_COLUMN.search(col):
            continue
        cells = [str(r.get(col, "")).strip() for r in rows]
        present = [c for c in cells if c]
        if not present or len(set(present)) == 1:
            continue
        parsed = [to_number(c) for c in present]
        if sum(v is not None for v in parsed) >= max(1, len(present) * 0.8):
            found.append(col)
    return found


def pick_metric(rows, columns, requested):
    if requested:
        if requested not in columns:
            raise ReportError(
                "No column %r. Available: %s" % (requested, ", ".join(columns))
            )
        return requested
    for candidate in METRIC_PREFERENCE:
        if candidate in columns:
            return candidate
    numeric = numeric_columns(rows, columns)
    if not numeric:
        raise ReportError(
            "No numeric column to total. Columns: %s" % ", ".join(columns)
        )
    return numeric[0]


def date_span(rows):
    """The min/max of whatever date column exists, for stating the real window."""
    for col in ("Date", "Begin Date", "End Date"):
        values = sorted({str(r[col]).strip() for r in rows if r.get(col, "").strip()})
        if values:
            return col, values[0], values[-1]
    return None, None, None


def aggregate(rows, by, metric):
    """Sum `metric` per distinct tuple of `by` columns."""
    totals = {}
    counted = 0
    for row in rows:
        value = to_number(row.get(metric))
        if value is None:
            continue
        key = tuple(str(row.get(col, "")).strip() or "(blank)" for col in by)
        totals[key] = totals.get(key, 0.0) + value
        counted += 1
    return totals, counted


def fmt(number):
    """Whole numbers read as counts; fractions are money and keep 2 places."""
    if abs(number - round(number)) < 1e-9:
        return "{:,}".format(int(round(number)))
    return "{:,.2f}".format(number)


def render_table(pairs, headers, total=None, total_column=-2):
    lines = []
    widths = [len(h) for h in headers]
    for row in pairs:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    lines.append("  ".join(h.ljust(widths[i]) for i, h in enumerate(headers)).rstrip())
    lines.append("  ".join("-" * widths[i] for i in range(len(headers))))
    for row in pairs:
        cells = []
        for i, cell in enumerate(row):
            text = str(cell)
            cells.append(text.rjust(widths[i]) if i else text.ljust(widths[i]))
        lines.append("  ".join(cells).rstrip())
    if total is not None:
        lines.append("  ".join("-" * widths[i] for i in range(len(headers))))
        # The total belongs under the metric column only. Repeating it under
        # every trailing column (share, %) reads as a second, contradictory
        # figure.
        cells = ["TOTAL".ljust(widths[0])] + [" " * widths[i] for i in range(1, len(headers))]
        cells[total_column] = str(total).rjust(widths[total_column])
        lines.append("  ".join(cells).rstrip())
    return "\n".join(lines)


def guard_truncation(path, truncated, note, allowed):
    if not truncated:
        return
    message = (
        "%s was TRUNCATED by the report tool, so every total below is a floor, "
        "not a total.%s Re-fetch it with a higher maxLines, or switch to a "
        "SUMMARY subtype / narrower window." % (path, (" " + note) if note else "")
    )
    if not allowed:
        raise ReportError(message)
    print("!! %s\n" % message)


def cmd_summary(args):
    for path in args.files:
        rows, columns, truncated, note = read_report(path)
        guard_truncation(path, truncated, note, args.allow_truncated)
        print("== %s" % path)
        print("   rows: %d" % len(rows))
        col, first, last = date_span(rows)
        if col:
            print("   %s: %s .. %s" % (col, first, last))
        print("   columns: %s" % ", ".join(columns))
        numeric = numeric_columns(rows, columns)
        for metric in numeric:
            totals, counted = aggregate(rows, [], metric)
            value = totals.get((), 0.0)
            flag = "  (not additive -- upper bound)" if metric in NON_ADDITIVE else ""
            print("   sum(%s) = %s over %d rows%s" % (metric, fmt(value), counted, flag))
        # Dimensions are the interesting thing to group by next, so name the
        # low-cardinality ones rather than making the caller guess.
        dims = []
        for col_name in columns:
            if col_name in numeric:
                continue
            distinct = len({str(r.get(col_name, "")).strip() for r in rows})
            if 1 < distinct <= 40:
                dims.append("%s(%d)" % (col_name, distinct))
        if dims:
            print("   groupable: %s" % ", ".join(dims))
        print()
    return 0


def apply_where(rows, where):
    if not where:
        return rows
    for clause in where:
        if "=" not in clause:
            raise ReportError("--where takes COL=VALUE, got %r" % clause)
        col, _, wanted = clause.partition("=")
        col, wanted = col.strip(), wanted.strip()
        rows = [r for r in rows if str(r.get(col, "")).strip() == wanted]
    return rows


def cmd_group(args):
    rows, columns, truncated, note = read_report(args.file)
    guard_truncation(args.file, truncated, note, args.allow_truncated)
    rows = apply_where(rows, args.where)
    if not rows:
        raise ReportError("No rows left after --where. Check the value spelling.")

    by = [c.strip() for c in args.by.split(",")]
    for col in by:
        if col not in columns:
            raise ReportError("No column %r. Available: %s" % (col, ", ".join(columns)))
    metric = pick_metric(rows, columns, args.metric)

    totals, counted = aggregate(rows, by, metric)
    ordered = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
    grand = sum(totals.values())
    shown = ordered[: args.top] if args.top else ordered

    pairs = []
    for key, value in shown:
        share = ("%.1f%%" % (100.0 * value / grand)) if grand else "-"
        pairs.append(list(key) + [fmt(value), share])

    print("%s by %s -- %d rows" % (metric, ", ".join(by), counted))
    if metric in NON_ADDITIVE:
        print(
            "NOTE: %s does not add up across rows (a device can appear in several).\n"
            "      Treat this as an upper bound, not a user count." % metric
        )
    col_name, first, last = date_span(rows)
    if col_name:
        print("%s: %s .. %s" % (col_name, first, last))
    print()
    print(render_table(pairs, by + [metric, "share"], total=fmt(grand)))
    if args.top and len(ordered) > args.top:
        rest = sum(v for _, v in ordered[args.top :])
        print("\n(%d more rows, %s remaining)" % (len(ordered) - args.top, fmt(rest)))
    return 0


def cmd_money(args):
    """Total a Sales and Trends report without mixing currencies.

    Kept separate from `group` because the money columns need different
    arithmetic: they are per-unit, so they have to be weighted by Units before
    anything is summed, and a total that spans currencies is meaningless no
    matter how it is computed.
    """
    rows, columns, truncated, note = read_report(args.file)
    guard_truncation(args.file, truncated, note, args.allow_truncated)

    if UNITS not in columns:
        raise ReportError(
            "No %r column -- this does not look like a Sales and Trends report. "
            "For an Analytics report use `group` instead." % UNITS
        )

    have_price = PER_UNIT_PRICE in columns
    have_proceeds = PER_UNIT_PROCEEDS in columns
    if not (have_price or have_proceeds):
        raise ReportError(
            "Neither %r nor %r is present, so there is no money in this report. "
            "A free app's SALES report is units-only." % (PER_UNIT_PRICE, PER_UNIT_PROCEEDS)
        )

    by = [c.strip() for c in args.by.split(",")] if args.by else []
    for col in by:
        if col not in columns:
            raise ReportError("No column %r. Available: %s" % (col, ", ".join(columns)))

    # Currency is part of the key whether the caller asked for it or not:
    # rolling EUR and USD into one figure is the trap this command exists to
    # close, and silently picking one currency would be worse than refusing.
    currency_col = (
        CURRENCY_OF_PROCEEDS
        if (have_proceeds and CURRENCY_OF_PROCEEDS in columns)
        else (CURRENCY_OF_PRICE if have_price and CURRENCY_OF_PRICE in columns else None)
    )

    buckets = {}
    for row in rows:
        units = to_number(row.get(UNITS)) or 0.0
        if not units:
            continue
        currency = str(row.get(currency_col, "")).strip() if currency_col else "?"
        key = (currency,) + tuple(
            str(row.get(col, "")).strip() or "(blank)" for col in by
        )
        bucket = buckets.setdefault(key, {"units": 0.0, "spend": 0.0, "proceeds": 0.0})
        bucket["units"] += units
        if have_price:
            bucket["spend"] += units * (to_number(row.get(PER_UNIT_PRICE)) or 0.0)
        if have_proceeds:
            bucket["proceeds"] += units * (to_number(row.get(PER_UNIT_PROCEEDS)) or 0.0)

    if not buckets:
        raise ReportError("Every row has zero units -- nothing to total.")

    headers = ["currency"] + by + ["units"]
    if have_price:
        headers.append("customer spend")
    if have_proceeds:
        headers.append("est. proceeds")

    ordered = sorted(buckets.items(), key=lambda kv: kv[1]["proceeds"] or kv[1]["units"], reverse=True)
    if args.top:
        ordered = ordered[: args.top]

    pairs = []
    for key, agg in ordered:
        row = list(key) + [fmt(agg["units"])]
        if have_price:
            row.append(fmt(agg["spend"]))
        if have_proceeds:
            row.append(fmt(agg["proceeds"]))
        pairs.append(row)

    col_name, first, last = date_span(rows)
    if col_name:
        print("%s: %s .. %s" % (col_name, first, last))
    print(
        "Money is per-unit in this report, so these are Units x %s / Units x %s."
        % (PER_UNIT_PRICE, PER_UNIT_PROCEEDS)
    )
    print(
        "Proceeds are Apple's post-commission estimate. The finance report is "
        "the authoritative figure for what you were actually paid.\n"
    )
    print(render_table(pairs, headers))
    # Units mixes new purchases with free updates and redownloads unless the
    # product type is pinned. That inflates "units" while leaving spend flat,
    # which reads as a collapsed price rather than as two different events.
    types = {str(r.get(PRODUCT_TYPE, "")).strip() for r in rows if r.get(PRODUCT_TYPE, "").strip()}
    if len(types) > 1 and PRODUCT_TYPE not in by:
        print(
            "\nNOTE: %d product types in this file (%s), so `units` mixes first-time "
            "purchases with updates and redownloads. Re-run with "
            "--by '%s' to separate them; see references/asc-metrics.md for what "
            "the codes mean." % (len(types), ", ".join(sorted(types)), PRODUCT_TYPE)
        )

    currencies = {key[0] for key in buckets}
    if len(currencies) > 1:
        print(
            "\nNOTE: %d currencies here (%s). They are listed separately on "
            "purpose -- do not add these rows together. Use the finance report "
            "for one consolidated figure." % (len(currencies), ", ".join(sorted(currencies)))
        )
    return 0


def cmd_compare(args):
    base_rows, base_cols, base_trunc, base_note = read_report(args.base)
    cur_rows, cur_cols, cur_trunc, cur_note = read_report(args.current)
    guard_truncation(args.base, base_trunc, base_note, args.allow_truncated)
    guard_truncation(args.current, cur_trunc, cur_note, args.allow_truncated)

    by = [c.strip() for c in args.by.split(",")]
    for col in by:
        for cols, path in ((base_cols, args.base), (cur_cols, args.current)):
            if col not in cols:
                raise ReportError("No column %r in %s." % (col, path))
    metric = pick_metric(cur_rows, cur_cols, args.metric)
    if metric not in base_cols:
        raise ReportError(
            "%r is in %s but not %s -- the two reports are not the same type, "
            "so a comparison would be meaningless." % (metric, args.current, args.base)
        )

    base_totals, _ = aggregate(base_rows, by, metric)
    cur_totals, _ = aggregate(cur_rows, by, metric)

    keys = set(base_totals) | set(cur_totals)
    deltas = []
    for key in keys:
        before = base_totals.get(key, 0.0)
        after = cur_totals.get(key, 0.0)
        change = after - before
        pct = ("%+.1f%%" % (100.0 * change / before)) if before else ("new" if after else "-")
        deltas.append((key, before, after, change, pct))

    deltas.sort(key=lambda d: abs(d[3]), reverse=True)
    shown = deltas[: args.top] if args.top else deltas

    base_sum = sum(base_totals.values())
    cur_sum = sum(cur_totals.values())
    overall = cur_sum - base_sum
    overall_pct = ("%+.1f%%" % (100.0 * overall / base_sum)) if base_sum else "-"

    _, b_first, b_last = date_span(base_rows)
    _, c_first, c_last = date_span(cur_rows)
    print("%s by %s" % (metric, ", ".join(by)))
    if b_first:
        print("  base:    %s  %s .. %s" % (args.base, b_first, b_last))
    if c_first:
        print("  current: %s  %s .. %s" % (args.current, c_first, c_last))
    print(
        "\nTotal %s -> %s  (%s, %s)\n"
        % (fmt(base_sum), fmt(cur_sum), fmt(overall), overall_pct)
    )
    pairs = [
        list(key) + [fmt(before), fmt(after), fmt(change), pct]
        for key, before, after, change, pct in shown
    ]
    print(render_table(pairs, by + ["base", "current", "change", "%"]))
    if args.top and len(deltas) > args.top:
        print("\n(%d more rows, ordered by absolute change)" % (len(deltas) - args.top))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--allow-truncated",
        action="store_true",
        help="Proceed on a truncated report. Every total becomes a floor -- only "
        "use this to inspect the shape of a file, never to quote a number.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_summary = sub.add_parser(
        "summary", help="Columns, row count, date span and every numeric total."
    )
    p_summary.add_argument("files", nargs="+")
    p_summary.set_defaults(func=cmd_summary)

    p_group = sub.add_parser("group", help="Sum a metric per dimension, ranked.")
    p_group.add_argument("file")
    p_group.add_argument("--by", required=True, help="Column(s) to group by, comma-separated.")
    p_group.add_argument("--metric", help="Column to sum. Auto-detected when omitted.")
    p_group.add_argument("--top", type=int, default=15, help="0 for all rows.")
    p_group.add_argument(
        "--where", action="append", help="Filter as COL=VALUE. Repeatable."
    )
    p_group.set_defaults(func=cmd_group)

    p_money = sub.add_parser(
        "money", help="Sales report totals, weighted per-unit and split by currency."
    )
    p_money.add_argument("file")
    p_money.add_argument("--by", help="Extra column(s) to break down by.")
    p_money.add_argument("--top", type=int, default=15, help="0 for all rows.")
    p_money.set_defaults(func=cmd_money)

    p_compare = sub.add_parser("compare", help="Per-row delta between two periods.")
    p_compare.add_argument("base", help="The earlier report.")
    p_compare.add_argument("current", help="The later report.")
    p_compare.add_argument("--by", required=True)
    p_compare.add_argument("--metric")
    p_compare.add_argument("--top", type=int, default=15, help="0 for all rows.")
    p_compare.set_defaults(func=cmd_compare)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ReportError as err:
        print("error: %s" % err, file=sys.stderr)
        return 2
    except FileNotFoundError as err:
        print("error: %s" % err, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
