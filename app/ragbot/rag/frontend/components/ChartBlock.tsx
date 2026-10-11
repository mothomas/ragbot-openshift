"use client";
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
  type PieLabelRenderProps,
} from "recharts";
import type { Block } from "@/lib/chat";
import { fmt } from "@/lib/format";
import { boot } from "@/lib/frappe";
import { Table } from "./parts";

type Series = { name: string; values: (number | null)[] };
type Options = { format?: string; currency?: string; stacked?: boolean };

// The validated palette has three slots, so a fourth series folds into "Other"; colour follows
// the series' position, never its rank, and never cycles.
const SERIES = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
];
const sum = (xs: (number | null)[]) =>
  xs.reduce<number>((a, x) => a + (x ?? 0), 0);

function fold(series: Series[]): Series[] {
  if (series.length <= 3) return series;
  const rest = series.slice(2);
  return [
    ...series.slice(0, 2),
    {
      name: "Other",
      values: rest[0].values.map((_, i) => sum(rest.map((s) => s.values[i]))),
    },
  ];
}

const text = { fill: "var(--chart-text)", fontSize: 12 };
const tooltip = {
  contentStyle: {
    background: "var(--chart-surface)",
    border: "1px solid var(--chart-grid)",
    borderRadius: 12,
    fontSize: 12,
  },
  itemStyle: { color: "var(--chart-text)" },
  labelStyle: { color: "var(--chart-ink)" },
};
const legend = (v: string) => (
  <span style={{ color: "var(--chart-text)", fontSize: 12 }}>{v}</span>
);

export default function ChartBlock({ block }: { block: Block }) {
  const [asTable, setAsTable] = useState(false);
  const data = block.data as { labels: string[]; datasets: Series[] };
  const opts = (block.options as Options) ?? {};
  const f = (v: unknown) =>
    fmt(v, opts.format, opts.currency ?? boot().currency);
  const kind = block.chart_type as string;
  const title = typeof block.title === "string" ? block.title : "";
  // heatmap and calendar values are grids, and a funnel is an ordered list of stages; all read plainly as a table
  const tableOnly =
    kind === "heatmap" || kind === "calendar" || kind === "funnel";
  const series = tableOnly ? data.datasets : fold(data.datasets);
  const rows = data.labels.map((label, i) => ({
    label,
    ...Object.fromEntries(series.map((s) => [s.name, s.values[i]])),
  }));
  const slices =
    kind === "pie"
      ? fold(
          data.labels.map((label, i) => ({
            name: label,
            values: [series[0]?.values[i] ?? 0],
          })),
        )
      : [];
  const axis = {
    tick: { fill: "var(--chart-ink)", fontSize: 12 },
    tickLine: false,
    axisLine: false,
  };
  // Recharts sorts legends and tooltips alphabetically; keep the series' own order
  const order = (kind === "pie" ? slices : series).map((s) => s.name);
  const byOrder = (name: unknown) => order.indexOf(String(name));
  const key = {
    itemSorter: (i: { value?: unknown }) => byOrder(i.value),
    formatter: legend,
  };
  const tip = {
    ...tooltip,
    formatter: f,
    itemSorter: (i: { name?: unknown }) => byOrder(i.name),
  };
  const chart = {
    title,
    responsive: true,
    style: { width: "100%", height: 224 },
    margin: { top: 20, right: 8, bottom: 0, left: 0 },
  };

  return (
    <figure className="my-3">
      <figcaption className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-base leading-snug font-medium text-gray-900 dark:text-white">
          {title}
        </span>
        {!tableOnly && (
          <button
            onClick={() => setAsTable((t) => !t)}
            className="text-xs text-gray-600 dark:text-gray-400 hover:underline shrink-0"
          >
            {asTable ? "Show chart" : "Show table"}
          </button>
        )}
      </figcaption>
      {asTable || tableOnly ? (
        <Table
          columns={[
            { key: "label", label: "" },
            ...series.map((s) => ({
              key: s.name,
              label: s.name,
              format: opts.format,
            })),
          ]}
          rows={rows.map((r) => ({ values: r }))}
          currency={opts.currency}
        />
      ) : kind === "pie" ? (
        <PieChart {...chart}>
          <Pie
            data={slices.map((s, i) => ({
              label: s.name,
              value: s.values[0],
              fill: SERIES[i],
            }))}
            dataKey="value"
            nameKey="label"
            innerRadius="55%"
            stroke="var(--chart-surface)"
            strokeWidth={2}
            label={(p: PieLabelRenderProps) => (
              <text
                x={p.x}
                y={p.y}
                textAnchor={p.textAnchor}
                dominantBaseline="central"
                {...text}
              >
                {f(p.value)}
              </text>
            )}
          />
          <Tooltip {...tip} />
          <Legend {...key} />
        </PieChart>
      ) : kind === "line" ? (
        <LineChart data={rows} {...chart}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" {...axis} />
          <YAxis {...axis} tickFormatter={f} width="auto" />
          <Tooltip {...tip} />
          {series.length > 1 && <Legend {...key} />}
          {series.map((s, i) => (
            <Line
              key={s.name}
              dataKey={s.name}
              stroke={SERIES[i]}
              strokeWidth={2}
              dot={{ r: 4 }}
            />
          ))}
        </LineChart>
      ) : (
        <BarChart data={rows} {...chart}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" {...axis} />
          <YAxis {...axis} tickFormatter={f} width="auto" />
          <Tooltip cursor={{ fill: "var(--chart-grid)" }} {...tip} />
          {series.length > 1 && <Legend {...key} />}
          {series.map((s, i) => (
            <Bar
              key={s.name}
              dataKey={s.name}
              fill={SERIES[i]}
              maxBarSize={48}
              stackId={opts.stacked ? "s" : undefined}
              radius={opts.stacked ? 0 : [4, 4, 0, 0]}
              {...(opts.stacked && {
                stroke: "var(--chart-surface)",
                strokeWidth: 2,
              })}
            >
              {!opts.stacked && (
                <LabelList
                  dataKey={s.name}
                  position="top"
                  formatter={f}
                  {...text}
                />
              )}
            </Bar>
          ))}
        </BarChart>
      )}
    </figure>
  );
}
