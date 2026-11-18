"use client";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";

export interface Column<T> {
  key: keyof T & string;
  label: string;
  format?: (value: T[keyof T]) => string;
}

/** A chart with a title and a table view of the same rows (for screen readers, print, and the low-contrast series). */
export function ChartCard<T extends { start: string }>({
  title,
  description,
  rows,
  columns,
  legend,
  className,
  chartHeight = "h-56",
  children,
}: {
  title: string;
  description?: string;
  rows: T[];
  columns: Column<T>[];
  legend?: Array<{ label: string; color: string }>;
  className?: string;
  chartHeight?: string;
  children: ReactNode;
}) {
  const [table, setTable] = useState(false);
  return (
    <figure className={`space-y-3 rounded-lg border border-border bg-card p-4 ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-2">
        <figcaption className="min-w-0">
          <span className="font-medium">{title}</span>
          {description ? <span className="block text-xs text-muted-foreground">{description}</span> : null}
        </figcaption>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          aria-pressed={table}
          onClick={() => setTable((t) => !t)}
        >
          {table ? "Show as chart" : "Show as table"}
        </Button>
      </div>
      {legend && !table ? (
        <ul className="flex flex-wrap gap-4 text-xs text-muted-foreground" aria-label={`${title} legend`}>
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-sm" style={{ background: l.color }} />
              {l.label}
            </li>
          ))}
        </ul>
      ) : null}
      {table ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-sm" aria-label={title}>
            <thead className="text-muted-foreground">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className="px-2 py-1 font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.start} className="border-t border-border">
                  {columns.map((c) => (
                    <td key={c.key} className="px-2 py-1 tabular-nums">
                      {c.format ? c.format(r[c.key]) : String(r[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={`${chartHeight} w-full`}>{children}</div>
      )}
    </figure>
  );
}
