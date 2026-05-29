#!/usr/bin/env node
// Merge a fresh `ccusage daily --json` snapshot into a cumulative store keyed by date.
//
// Why: `ccusage` reads local Claude Code logs (~/.claude/projects/*.jsonl) which are
// auto-deleted after `cleanupPeriodDays` (default 30). Running daily and merging into a
// committed file preserves the full history beyond that retention window.
//
// Usage: node merge.mjs <fresh-snapshot.json> <cumulative.json>
// The cumulative file is created if missing. Each day's latest figures overwrite the
// previous record for that day (so today's still-growing numbers stay up to date).

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [, , freshPath, cumulativePath] = process.argv;
if (!freshPath || !cumulativePath) {
  console.error("usage: node merge.mjs <fresh.json> <cumulative.json>");
  process.exit(1);
}

const fresh = JSON.parse(readFileSync(freshPath, "utf8"));
const store = existsSync(cumulativePath)
  ? JSON.parse(readFileSync(cumulativePath, "utf8"))
  : { days: {} };

if (!store.days) store.days = {};

for (const row of fresh.daily ?? []) {
  const date = row.period;
  if (!date) continue;
  store.days[date] = {
    date,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheCreationTokens: row.cacheCreationTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    totalTokens: row.totalTokens ?? 0,
    // Hypothetical pay-as-you-go cost (USD) back-calculated from token counts.
    estimatedCostUSD: row.totalCost ?? 0,
    modelsUsed: row.modelsUsed ?? [],
    updatedAt: new Date().toISOString(),
  };
}

store.lastRunAt = new Date().toISOString();

// Stable, date-sorted output for clean diffs.
const sorted = Object.keys(store.days).sort();
const out = { lastRunAt: store.lastRunAt, days: {} };
for (const d of sorted) out.days[d] = store.days[d];

writeFileSync(cumulativePath, JSON.stringify(out, null, 2) + "\n");

// Also emit a flat CSV next to the JSON for easy spreadsheet / glance review.
const csvPath = cumulativePath.replace(/\.json$/, ".csv");
const header =
  "date,inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,totalTokens,estimatedCostUSD,modelsUsed";
const lines = sorted.map((d) => {
  const r = out.days[d];
  return [
    r.date,
    r.inputTokens,
    r.outputTokens,
    r.cacheCreationTokens,
    r.cacheReadTokens,
    r.totalTokens,
    r.estimatedCostUSD,
    `"${(r.modelsUsed || []).join("|")}"`,
  ].join(",");
});
writeFileSync(csvPath, [header, ...lines].join("\n") + "\n");

const total = sorted.reduce((s, d) => s + (out.days[d].estimatedCostUSD || 0), 0);
console.log(
  `merged ${fresh.daily?.length ?? 0} day(s); store now has ${sorted.length} day(s), ` +
    `cumulative estimated cost $${total.toFixed(2)}`,
);
