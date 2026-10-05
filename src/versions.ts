/**
 * Compare version strings numerically, segment by segment, for sorting.
 *
 * A lexical sort puts "1.10.0" before "1.9.0". In a listing export that quietly
 * picks the wrong version's copy; in a portfolio report it resolves a tie Apple
 * should never produce arbitrarily, which is how a number nobody can reproduce
 * gets in. Missing or non-numeric segments count as 0, so "1.2" equals "1.2.0".
 */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
};
