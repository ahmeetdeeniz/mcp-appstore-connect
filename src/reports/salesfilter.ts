import { PreconditionError } from "#/client/errors";
import { cellAt, columnIndexes, splitReport } from "#/reports/tsv";

/** The sales TSV columns identifying an app, named as Apple spells them. */
const SALES_FILTER_COLUMNS = {
  appleIdentifier: "Apple Identifier",
  sku: "SKU",
} as const;
/**
 * The column an in-app purchase row names its parent app in — by SKU, not by the
 * numeric Apple Identifier the rest of the filtering uses. See filterSalesReport.
 */
const PARENT_COLUMN = "Parent Identifier";
type SalesFilter = { appleIdentifier?: string; sku?: string; includeInAppPurchases?: boolean };
/**
 * Keep only the rows belonging to one app, before anything is truncated.
 *
 * Apple has no per-app filter on the sales endpoint, so the TSV is account-wide:
 * every app the vendor ships, interleaved rather than grouped. Two things go
 * wrong when the caller filters it by eye afterwards. The obvious one is
 * quoting a portfolio total as one app's. The subtler one is that `maxLines`
 * then truncates across the interleaving, so a dropped tail removes an
 * arbitrary slice of *every* app — `truncated: true` says something was lost
 * but not that one app vanished from it entirely.
 *
 * Filtering here fixes both: the limit applies to the rows that were asked for,
 * so `truncated` means what it says, and the dropped count is reported rather
 * than left to be inferred.
 *
 * The third thing that goes wrong is the reason `includeInAppPurchases` exists.
 * An in-app purchase row does *not* carry its app's Apple Identifier — it carries
 * the IAP's own, and names the app only in `Parent Identifier`, as the app's SKU
 * string rather than its numeric id. So filtering an account-wide report to an app
 * id drops every IA1 / IA1-M row and returns a clean, plausible, `truncated: false`
 * report showing no in-app revenue at all. Nothing about that answer looks wrong;
 * two separate real runs of the reporting skill came one probe away from publishing
 * "this app has never earned anything" off the back of it.
 *
 * The app's SKU does not have to be supplied to fix this: it is already on the
 * app's own rows, so a first pass over the direct matches yields the parent keys a
 * second pass needs. The one case that cannot self-heal is an app with no direct
 * rows in the period, where there is nothing to read the SKU off — that one is
 * reported rather than silently returning fewer rows than exist.
 */
export const filterSalesReport = (
  tsv: string,
  filter: SalesFilter,
): {
  tsv: string;
  matchedRows: number;
  droppedRows: number;
  inAppPurchaseRows: number;
  parentSkus: string[];
  hasParentColumn: boolean;
  droppedChildRows: number;
  droppedChildParents: string[];
  availableColumn: string;
  available: string[];
  availableParents: string[];
} => {
  const empty = {
    matchedRows: 0,
    droppedRows: 0,
    inAppPurchaseRows: 0,
    parentSkus: [],
    hasParentColumn: false,
    droppedChildRows: 0,
    droppedChildParents: [],
    availableColumn: "",
    available: [],
    availableParents: [],
  };
  const split = splitReport(tsv);
  if (split === undefined) return { tsv, ...empty };
  const { header, rows } = split;
  const columns = columnIndexes(header);

  const wanted = Object.entries(SALES_FILTER_COLUMNS)
    .map(([key, column]) => ({ key, column, value: filter[key as keyof SalesFilter] }))
    .filter((entry) => entry.value !== undefined && entry.value !== "");

  // A filter the report cannot honour must fail loudly. Ignoring it would hand
  // back the whole portfolio under a name that claims one app — precisely the
  // mistake this argument exists to prevent.
  const missing = wanted.filter((entry) => !columns.has(entry.column));
  if (missing.length > 0) {
    throw new PreconditionError(
      `This report has no ${missing.map((entry) => `"${entry.column}"`).join(" or ")} column, so ` +
        `it cannot be filtered by app. Summary reports carry it; some reportType / reportSubType ` +
        `combinations do not. Columns present: ${[...columns.keys()].join(", ")}.`,
      { columns: [...columns.keys()] },
    );
  }

  const direct = new Set<number>();
  rows.forEach((row, index) => {
    if (wanted.every((entry) => cellAt(row, columns.get(entry.column) as number) === entry.value)) {
      direct.add(index);
    }
  });

  // The parent keys are SKUs. An explicit `sku` filter is one directly; otherwise
  // they come off the app's own rows, which carry both identifiers side by side.
  const skuIndex = columns.get(SALES_FILTER_COLUMNS.sku);
  const parentIndex = columns.get(PARENT_COLUMN);
  const parentSkus = new Set<string>();
  if (filter.sku !== undefined && filter.sku !== "") parentSkus.add(filter.sku);
  if (skuIndex !== undefined) {
    for (const index of direct) {
      const value = cellAt(rows[index] as string, skuIndex);
      if (value !== "") parentSkus.add(value);
    }
  }

  // Children are found whether or not they are wanted: a caller who opts out still
  // needs to be told what opting out cost them, and that count is the whole point
  // of the note. Only the membership of `keep` depends on the flag.
  const children = new Set<number>();
  if (parentIndex !== undefined && parentSkus.size > 0) {
    rows.forEach((row, index) => {
      if (direct.has(index)) return;
      if (parentSkus.has(cellAt(row, parentIndex))) children.add(index);
    });
  }

  const includeChildren = filter.includeInAppPurchases !== false;
  const keep = includeChildren ? new Set([...direct, ...children]) : direct;
  // One pass over the original rows, so the output keeps the file's order rather
  // than listing the app's rows and then its purchases.
  const matched = rows.filter((_row, index) => keep.has(index));

  const distinct = (index: number | undefined, from: Set<number> | undefined): string[] =>
    index === undefined
      ? []
      : [
          ...new Set(
            (from === undefined ? rows : rows.filter((_row, i) => from.has(i))).map((row) =>
              cellAt(row, index),
            ),
          ),
        ]
          .filter((value) => value !== "")
          .slice(0, 25);

  // Only computed for the empty result, where naming the values actually present
  // is what distinguishes a typo from a report for the wrong account — and, since
  // the IAP split, from an app whose rows are all keyed under a parent.
  const probe = wanted[0];
  const nothingMatched = matched.length === 0;

  return {
    tsv: [header, ...matched].join("\n") + "\n",
    matchedRows: matched.length,
    droppedRows: rows.length - matched.length,
    inAppPurchaseRows: includeChildren ? children.size : 0,
    parentSkus: [...parentSkus],
    hasParentColumn: parentIndex !== undefined,
    droppedChildRows: includeChildren ? 0 : children.size,
    droppedChildParents: includeChildren ? [] : distinct(parentIndex, children),
    availableColumn: probe?.column ?? "",
    available:
      nothingMatched && probe !== undefined ? distinct(columns.get(probe.column), undefined) : [],
    availableParents: nothingMatched ? distinct(parentIndex, undefined) : [],
  };
};
/**
 * Say what the filter did in the two cases where the rows alone mislead.
 *
 * An empty result is the older of the two: it reads as "this app earned nothing"
 * when it usually means the id belongs to another account. Naming the values the
 * report does hold — including the parent identifiers, since the IAP split — turns
 * that into a fact the caller can act on.
 *
 * The newer case is a non-empty result that is quietly incomplete: children found
 * but excluded, or an app whose SKU could not be derived because it has no rows of
 * its own this period. Both return a well-formed report that is missing revenue,
 * which is the failure this whole mechanism exists to prevent, so neither is
 * allowed to pass silently.
 */
export const salesFilterNote = (
  filtered: ReturnType<typeof filterSalesReport>,
  sku: string | undefined,
): string | undefined => {
  if (filtered.matchedRows === 0) {
    const parents = filtered.availableParents.length
      ? ` "${PARENT_COLUMN}" values present: ${filtered.availableParents.join(", ")} — an ` +
        `in-app purchase names its app there, by SKU, so a match in that list means the right ` +
        `app filtered by the wrong column.`
      : "";
    return (
      `No rows matched. The report holds ${filtered.droppedRows} rows for other ` +
      `apps, so the period itself is not empty — this is a filter that did not ` +
      `match, most often a correct-looking id from a different account. ` +
      `"${filtered.availableColumn}" values present: ` +
      `${filtered.available.join(", ") || "none"}.${parents}`
    );
  }

  if (filtered.droppedChildRows > 0) {
    return (
      `${filtered.droppedChildRows} dropped rows carry ${PARENT_COLUMN} ` +
      `${filtered.droppedChildParents.join(", ")} — these are this app's in-app purchases, ` +
      `excluded because includeInAppPurchases is false. Any revenue on them is missing from ` +
      `the totals below.`
    );
  }

  if (filtered.hasParentColumn && filtered.parentSkus.length === 0 && sku === undefined) {
    return (
      `This app has no rows of its own in this period, so its SKU could not be read off the ` +
      `report and no in-app purchase rows could be matched — ${PARENT_COLUMN} holds the SKU, ` +
      `not the app id. Pass sku to pick them up; without it, a period where only IAPs sold ` +
      `reads as zero.`
    );
  }

  if (filtered.inAppPurchaseRows > 0) {
    return (
      `${filtered.inAppPurchaseRows} of the ${filtered.matchedRows} rows are in-app purchases, ` +
      `matched through ${PARENT_COLUMN} = ${filtered.parentSkus.join(", ")}. They carry their ` +
      `own Apple Identifier and SKU, so these rows hold more than one of each — group by ` +
      `Product Type Identifier to separate app units from purchases.`
    );
  }

  return undefined;
};
