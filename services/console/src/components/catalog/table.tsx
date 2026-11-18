import type { ReactNode } from "react";

/** A plain data table: column headers and rows of cells. */
export function DataTable({
  headers,
  rows,
  label,
}: {
  headers: string[];
  rows: ReactNode[][];
  label: string;
}) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm" aria-label={label}>
        <thead className="bg-muted text-muted-foreground">
          <tr>
            {headers.map((h, i) => (
              <th key={h || i} scope="col" className="px-3 py-2 font-medium">
                {h ? h : <span className="sr-only">Actions</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are rebuilt from the query each render
            <tr key={r} className="border-t border-border align-top">
              {cells.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                <td key={i} className="px-3 py-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
