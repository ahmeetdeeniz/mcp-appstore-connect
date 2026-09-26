/**
 * Lines up to the last non-blank one: Apple ends a report with a newline, and
 * sometimes more than one. The single rule every row count here goes through,
 * so the preview, the saved file and a split cannot disagree.
 */
export const contentLineCount = (lines: readonly string[]): number => {
  let count = lines.length;
  while (count > 0 && lines[count - 1] === "") count -= 1;
  return count;
};
/**
 * Trim a downloaded TSV report so a huge one doesn't blow the context window.
 *
 * Apple terminates both the sales TSV and an analytics CSV segment with a
 * newline, so a naive `split` leaves a phantom empty line at the end. Counting
 * it overstates `lines`, and — the part that actually hurts — can tip a complete
 * report past `maxLines` and flag it truncated. That is not a cosmetic error:
 * `report_stats.py` treats truncation as a hard error precisely so a floor is
 * never quoted as a total, so a false flag makes it refuse a file that lost
 * nothing.
 *
 * It also counts data lines that are byte-identical to another data line.
 * Apple's reports are aggregates keyed by their dimension columns, so the same
 * key should appear once; a file where it appears twice double-counts, and every
 * total taken from it is wrong by exactly that much while looking perfectly
 * well-formed. That is truncation's mirror image, and it is not hypothetical —
 * an ONGOING monthly analytics instance was observed holding every row of its
 * most recent month twice, reporting 7,764 impressions where the
 * ONE_TIME_SNAPSHOT for the same month held 3,882, on three apps at once, with
 * nothing in the response saying so.
 *
 * Unlike truncation this is reported rather than treated as fatal: a DETAILED
 * subtype can legitimately repeat a line, so the caller is told to check rather
 * than stopped.
 *
 * Exported for direct unit testing: the trailing-newline rule is the kind of
 * off-by-one that a round-trip through a tool call can mask.
 */
export const previewReport = (tsv: string, maxLines: number): Record<string, unknown> => {
  const lines = tsv.split("\n");
  const count = contentLineCount(lines);

  // Data lines only — the header is unique by construction, and counting it
  // would make a single-row report look like it repeated itself.
  const seen = new Set<string>();
  let duplicateRows = 0;
  for (let i = 1; i < count; i += 1) {
    const line = lines[i] as string;
    if (seen.has(line)) duplicateRows += 1;
    else seen.add(line);
  }

  const inlineTruncated = count > maxLines;
  return {
    // Content lines with the header included, so this is one more than the
    // number of data rows. Named `lines` to match `saved.lines`: two names for
    // one count was itself a transcription trap, since `rows` reads as "data
    // rows" to everyone who has not read this function, and a caller checking a
    // transcription against it is off by exactly one and concludes it dropped a
    // row.
    lines: count,
    // Zero means Apple returned a header and nothing else.
    dataRows: Math.max(0, count - 1),
    // Describes `report` below — the copy inlined in this response — and nothing
    // else. A saved file is never truncated.
    inlineTruncated,
    ...(inlineTruncated ? { inlineNote: `Inlining the first ${maxLines} of ${count} lines.` } : {}),
    // Only present when there is something to say, so its absence is not a
    // claim and its presence is never noise.
    ...(duplicateRows > 0
      ? {
          duplicateRows,
          duplicateNote:
            `${duplicateRows} of ${Math.max(0, count - 1)} data rows are byte-identical to ` +
            `another row, so every total from this report is inflated by them. Apple's ONGOING ` +
            `monthly analytics instances have been seen doubling a whole month this way. ` +
            `Cross-check against the ONE_TIME_SNAPSHOT or a WEEKLY instance before quoting a ` +
            `figure, or de-duplicate first.`,
        }
      : {}),
    // Untruncated output is handed back byte-for-byte. Only the sliced path
    // drops the trailing newline, and there the text is already partial.
    report: inlineTruncated ? lines.slice(0, maxLines).join("\n") : tsv,
    /**
     * Deprecated alias for `inlineTruncated`, and unlike `rows` and `note` it is
     * kept rather than scheduled for removal.
     *
     * The asymmetry is what decides it. A reader that loses `rows` or `note`
     * fails loudly — a KeyError, an undefined, a failed assertion. A reader that
     * loses `truncated` fails *silently* in the one direction that matters:
     * `blob.get("truncated")` returns None, which is falsy, so a consumer that
     * refuses to total a truncated report stops refusing and publishes a floor
     * as a total. That is worse than the confusion the rename fixes, and it is
     * unobservable. So this stays, with its exact old value, indefinitely.
     */
    truncated: inlineTruncated,
  };
};
/**
 * Split a report into its header line and data lines, discarding the trailing
 * blank Apple leaves behind. Shares `previewReport`'s rule about that newline so
 * a row count taken here cannot disagree with the one reported there.
 */
export const splitReport = (tsv: string): { header: string; rows: string[] } | undefined => {
  const lines = tsv.split("\n");
  const count = contentLineCount(lines);
  if (count === 0) return undefined;
  return { header: lines[0] as string, rows: lines.slice(1, count) };
};
export const columnIndexes = (header: string): Map<string, number> =>
  new Map(header.split("\t").map((name, index) => [name.trim(), index] as const));
export const cellAt = (row: string, index: number): string => row.split("\t")[index]?.trim() ?? "";
/** `03/29/2026` -> `2026-03-29`; anything else is handed back untouched. */
const isoDate = (value: string): string => {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : value;
};
/**
 * Read the period a finance report actually covers out of its own rows.
 *
 * Apple keys finance reports by *fiscal* period, and its fiscal months are 4-4-5
 * weeks against a year that opens in late September — so `2026-07` is fiscal
 * month 7 of FY2026, roughly late March to early May, not July. Nothing in the
 * request says so and nothing in the response headline says so either, which
 * makes asking for the wrong quarter completely silent: a well-formed report
 * comes back, for a period nobody chose.
 *
 * The TSV carries `Start Date` and `End Date` on every row, so the answer is
 * already in the file. Surfacing it turns a trap that depends on knowing Apple's
 * fiscal calendar into a fact the caller can read off the result.
 *
 * Deliberately forgiving: finance reports are multi-section, and a shape this
 * does not recognise must return nothing rather than throw or guess. A missing
 * `coverage` costs a caller the convenience; a wrong one costs them the report.
 */
export const financeCoverage = (
  tsv: string,
): { startDate: string; endDate: string } | undefined => {
  const lines = tsv.split("\n");
  const headerIndex = lines.findIndex(
    (line) => line.includes("Start Date") && line.includes("End Date"),
  );
  if (headerIndex === -1) return undefined;

  const columns = columnIndexes(lines[headerIndex] as string);
  const start = columns.get("Start Date");
  const end = columns.get("End Date");
  if (start === undefined || end === undefined) return undefined;

  const row = lines.slice(headerIndex + 1).find((line) => line.trim() !== "");
  if (row === undefined) return undefined;

  const startDate = cellAt(row, start);
  const endDate = cellAt(row, end);
  if (startDate === "" || endDate === "") return undefined;
  return { startDate: isoDate(startDate), endDate: isoDate(endDate) };
};
/**
 * The distinct currencies a finance report's proceeds are stated in.
 *
 * Each row's `Extended Partner Share` is in that row's own `Partner Share
 * Currency`, and an all-regions (ZZ) report puts USD, EUR and JPY rows side by
 * side. Summing that column across them yields a number that looks like revenue
 * and means nothing. Same stance as `financeCoverage`: a shape this does not
 * recognise returns nothing rather than a guess.
 */
export const financeCurrencies = (tsv: string): string[] => {
  const lines = tsv.split("\n");
  const headerIndex = lines.findIndex((line) => line.includes("Currency"));
  if (headerIndex === -1) return [];

  const columns = columnIndexes(lines[headerIndex] as string);
  const column = columns.get("Partner Share Currency") ?? columns.get("Currency");
  if (column === undefined) return [];

  const currencies = new Set<string>();
  for (const line of lines.slice(headerIndex + 1)) {
    const value = cellAt(line, column);
    // Footer rows (Total_Rows, Total_Amount) and repeated headers are not codes.
    if (/^[A-Z]{3}$/.test(value)) currencies.add(value);
  }
  return [...currencies].toSorted();
};
/**
 * Analytics segments are comma-delimited while sales reports are tab-delimited,
 * and reading a CSV with a tab splitter yields one column holding everything.
 * Sniffed the same way report_stats.py does, rather than assumed per endpoint.
 */
const sniffDelimiter = (header: string): string =>
  header.split("\t").length >= header.split(",").length ? "\t" : ",";
/**
 * The real date range inside a report, read out of its Date column.
 *
 * The same move `financeCoverage` makes for the fiscal trap. An instance's
 * processingDate is when Apple GENERATED it, not what is inside it — a fresh
 * ONE_TIME_SNAPSHOT reports today while holding a year of history — so the only
 * honest answer to "which period did I actually get" comes from the data.
 */
export const csvCoverage = (
  csv: string,
): { firstDate: string; lastDate: string; rows: number } | null => {
  const lines = csv.split("\n").filter((line) => line.trim() !== "");
  const header = lines[0];
  if (header === undefined || lines.length < 2) return null;
  const delimiter = sniffDelimiter(header);
  const index = header.split(delimiter).findIndex((col) => col.trim().toLowerCase() === "date");
  if (index === -1) return null;
  const dates = lines
    .slice(1)
    .map((line) => (line.split(delimiter)[index] ?? "").trim())
    .filter((date) => date !== "")
    .toSorted();
  if (dates.length === 0) return null;
  return {
    firstDate: dates[0] as string,
    lastDate: dates[dates.length - 1] as string,
    rows: lines.length - 1,
  };
};
const stripTrailingNewlines = (part: string): string => part.replace(/\n+$/, "");

/**
 * Join several segments into one report, dropping the header Apple repeats on
 * each. A leftover header becomes a phantom data row and inflates every count.
 */
export const concatSegments = (parts: string[]): string => {
  const [first, ...rest] = parts;
  if (first === undefined) return "";
  // One segment is handed back byte for byte, trailing newline and all. Apple
  // terminates every report with one, and previewReport's row counting is built
  // around that — rewriting the bytes on the single-segment path would make the
  // common case differ from the raw download for no reason.
  if (rest.length === 0) return first;

  const header = first.split("\n")[0];
  const bodies = rest.map((part) => {
    const lines = part.split("\n");
    return stripTrailingNewlines(lines[0] === header ? lines.slice(1).join("\n") : part);
  });
  return `${[stripTrailingNewlines(first), ...bodies].filter((part) => part !== "").join("\n")}\n`;
};
