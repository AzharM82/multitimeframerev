import { useMemo, useState } from "react";

/**
 * Click-to-sort for the stock tables on the Sector Desk and Rotation tabs.
 *
 * Extracted rather than copied: the two tabs show the same column set and must
 * behave identically, and the non-obvious rules below are easy to get subtly
 * wrong on a second implementation.
 *
 *  - Nulls always sink to the bottom, in BOTH directions. A name with no 200-SMA
 *    history is "unknown", not "worst" — sorting it to the top on an ascending
 *    click would be actively misleading.
 *  - The first click on a numeric column sorts descending (biggest mover first);
 *    on a text column, ascending. Clicking the active column flips direction.
 *  - Sort state lives with the table, so it sticks while the underlying rows
 *    refresh or the selected group/industry changes.
 */

export interface SortColumn<K extends string> {
  key: K;
  label: string;
  /** Numeric columns sort desc-first and right-align; text sorts asc-first. */
  num: boolean;
  /** Optional header tooltip. */
  title?: string;
}

export interface TableSort<T, K extends string> {
  rows: T[];
  sortKey: K;
  sortDir: "asc" | "desc";
  onSort: (key: K, num: boolean) => void;
}

export function useTableSort<T, K extends string>(
  rows: T[],
  valueOf: (row: T, key: K) => number | string | null,
  initialKey: K,
  initialDir: "asc" | "desc" = "desc",
): TableSort<T, K> {
  const [sortKey, setSortKey] = useState<K>(initialKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialDir);

  const onSort = (key: K, num: boolean) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(num ? "desc" : "asc");
    }
  };

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = valueOf(a, sortKey);
      const bv = valueOf(b, sortKey);
      if (typeof av === "string" || typeof bv === "string") {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      }
      // Nulls to the bottom regardless of direction — see the note above.
      const an = av ?? (sortDir === "asc" ? Infinity : -Infinity);
      const bn = bv ?? (sortDir === "asc" ? Infinity : -Infinity);
      return sortDir === "asc" ? an - bn : bn - an;
    });
    return out;
  }, [rows, sortKey, sortDir, valueOf]);

  return { rows: sorted, sortKey, sortDir, onSort };
}

/**
 * The `<tr>` of sortable `<th>`s. Rendered inside the caller's own `<thead>`.
 *
 * `rowClass`/`cellClass` exist so the two tabs can keep their own type scale
 * without a second copy of the click/indicator logic — the Desk's header sits in
 * a larger table than Rotation's.
 */
export function SortHeaderRow<K extends string>({
  columns,
  sortKey,
  sortDir,
  onSort,
  rowClass = "text-[9px] uppercase tracking-wider text-text-secondary border-b border-border",
  cellClass = "px-2 py-1.5",
}: {
  columns: SortColumn<K>[];
  sortKey: K;
  sortDir: "asc" | "desc";
  onSort: (key: K, num: boolean) => void;
  rowClass?: string;
  cellClass?: string;
}) {
  return (
    <tr className={rowClass}>
      {columns.map((c) => (
        <th
          key={c.key}
          title={c.title ?? `Sort by ${c.label}`}
          onClick={() => onSort(c.key, c.num)}
          className={`${cellClass} cursor-pointer select-none hover:text-text-primary ${
            c.num ? "text-right" : "text-left"
          } ${c.key === sortKey ? "text-text-primary" : ""}`}
        >
          {c.label}
          <span className="inline-block w-2 ml-0.5">
            {c.key === sortKey ? (sortDir === "asc" ? "▲" : "▼") : ""}
          </span>
        </th>
      ))}
    </tr>
  );
}
