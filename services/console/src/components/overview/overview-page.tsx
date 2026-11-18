"use client";
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ProblemMessage } from "@/components/problem-message";
import {
  type ChartRow,
  chartRows,
  PRESETS,
  type Preset,
  percent,
  useStats,
  useUsage,
} from "@/lib/api/overview";
import { toProblem } from "@/lib/api/problem";
import { cn } from "@/lib/utils";
import { ChartCard } from "./chart-card";

const S1 = "var(--series-1)";
const S2 = "var(--series-2)";
const S3 = "var(--series-3)";
const AXIS = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false } as const;
const TOOLTIP = {
  contentStyle: {
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontSize: 12,
  },
  labelStyle: { color: "var(--foreground)" },
  itemStyle: { color: "var(--foreground)" },
  cursor: { fill: "var(--muted)" },
} as const;
const count = (v: unknown) => Number(v).toLocaleString();

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      {sub ? <dd className="text-xs text-muted-foreground">{sub}</dd> : null}
    </div>
  );
}

function UsageMeter() {
  const usage = useUsage();
  if (usage.error) return <ProblemMessage problem={toProblem(usage.error)} />;
  if (!usage.data) return null;
  const m = usage.data.month_to_date;
  const share = Math.min(1, m.share);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-4" data-testid="usage">
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <span className="font-medium">Events this month</span>
        <span className="text-muted-foreground">
          {count(m.events)} of {count(m.limit)} on the {usage.data.plan} plan ({percent(m.share)})
        </span>
      </div>
      <meter
        className="sr-only"
        aria-label="Events this month against the plan"
        min={0}
        max={m.limit}
        value={m.events}
      />
      <div aria-hidden className="h-2 rounded-full bg-muted">
        <div className="h-2 rounded-full" style={{ width: `${share * 100}%`, background: S1 }} />
      </div>
    </div>
  );
}

export function OverviewPage() {
  const [preset, setPreset] = useState<Preset>("24h");
  const stats = useStats(preset);
  const rows: ChartRow[] = stats.data ? chartRows(stats.data) : [];
  const t = stats.data?.totals;
  const finished = t ? t.deliveries.succeeded + t.deliveries.dead + t.deliveries.cancelled : 0;
  const deliveries = t ? Object.values(t.deliveries).reduce((a, b) => a + b, 0) : 0;
  const unit = stats.data?.bucket === "hour" ? "per hour" : "per day";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Overview</h1>
        <fieldset className="flex rounded-md border border-border p-0.5">
          <legend className="sr-only">Time range</legend>
          {(Object.keys(PRESETS) as Preset[]).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={preset === p}
              onClick={() => setPreset(p)}
              className={cn(
                "rounded px-3 py-1 text-sm",
                preset === p ? "bg-muted font-medium" : "text-muted-foreground",
              )}
            >
              {PRESETS[p].label}
            </button>
          ))}
        </fieldset>
      </div>

      {stats.error ? <ProblemMessage problem={toProblem(stats.error)} /> : null}
      {t ? (
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label="Events" value={count(t.events)} />
          <Tile label="Deliveries" value={count(deliveries)} sub={`${count(t.attempts)} send attempts`} />
          <Tile
            label="Success rate"
            value={percent(t.success_rate)}
            sub={`of ${count(finished)} finished deliveries`}
          />
          <Tile label="Failed" value={count(t.deliveries.dead)} sub="gave up after every retry" />
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">{stats.isPending ? "Loading…" : null}</p>
      )}

      <UsageMeter />

      {stats.data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            title="Events"
            description={`Events received ${unit}`}
            rows={rows}
            columns={[
              { key: "label", label: "Time" },
              { key: "events", label: "Events", format: count },
            ]}
          >
            <ResponsiveContainer>
              <BarChart data={rows} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
                <XAxis dataKey="label" {...AXIS} minTickGap={16} />
                <YAxis allowDecimals={false} {...AXIS} />
                <Tooltip {...TOOLTIP} formatter={(v) => [count(v), "Events"]} />
                <Bar dataKey="events" name="Events" fill={S1} radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard
            title="Deliveries by outcome"
            description={`Deliveries created ${unit}, by their current status`}
            rows={rows}
            legend={[
              { label: "Succeeded", color: S1 },
              { label: "Failed", color: S2 },
              { label: "In progress", color: S3 },
            ]}
            columns={[
              { key: "label", label: "Time" },
              { key: "succeeded", label: "Succeeded", format: count },
              { key: "failed", label: "Failed", format: count },
              { key: "inProgress", label: "In progress", format: count },
              { key: "cancelled", label: "Cancelled", format: count },
            ]}
          >
            <ResponsiveContainer>
              <BarChart data={rows} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
                <XAxis dataKey="label" {...AXIS} minTickGap={16} />
                <YAxis allowDecimals={false} {...AXIS} />
                <Tooltip {...TOOLTIP} formatter={(v, name) => [count(v), name]} />
                {/* a 2px surface-coloured stroke separates the stacked segments */}
                <Bar
                  dataKey="succeeded"
                  name="Succeeded"
                  stackId="o"
                  fill={S1}
                  stroke="var(--card)"
                  strokeWidth={2}
                  maxBarSize={24}
                />
                <Bar
                  dataKey="failed"
                  name="Failed"
                  stackId="o"
                  fill={S2}
                  stroke="var(--card)"
                  strokeWidth={2}
                  maxBarSize={24}
                />
                <Bar
                  dataKey="inProgress"
                  name="In progress"
                  stackId="o"
                  fill={S3}
                  stroke="var(--card)"
                  strokeWidth={2}
                  maxBarSize={24}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard
            title="Success rate"
            description={`Succeeded out of finished deliveries, ${unit}; gaps mean nothing finished`}
            className="lg:col-span-2"
            chartHeight="h-44"
            rows={rows}
            columns={[
              { key: "label", label: "Time" },
              { key: "successRate", label: "Success rate", format: (v) => (v === null ? "—" : `${v}%`) },
            ]}
          >
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
                <XAxis dataKey="label" {...AXIS} minTickGap={16} />
                <YAxis domain={[0, 100]} unit="%" {...AXIS} />
                <Tooltip
                  {...TOOLTIP}
                  cursor={{ stroke: "var(--muted-foreground)" }}
                  formatter={(v) => [`${v}%`, "Success rate"]}
                />
                <Line
                  dataKey="successRate"
                  name="Success rate"
                  stroke={S1}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      ) : null}
      {stats.data ? (
        <p className="text-xs text-muted-foreground">
          Times are bucketed in UTC. Counts refresh every minute and may be up to 30 seconds old.
        </p>
      ) : null}
    </section>
  );
}
