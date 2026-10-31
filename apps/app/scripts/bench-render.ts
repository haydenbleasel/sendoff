// Measures CPU time for parsing and rendering the sample issue, cold (first
// run in a fresh isolate) and warm. Sendoff needs Workers Paid because cold
// renders exceed the Workers Free 10 ms limit; use this to catch regressions.
//
// Run with `bun run bench`. It bundles this file with the same export
// conditions Workers uses (workerd, worker) and React's production build,
// then runs it on Node (V8, the same engine as workerd). Workers' CPUs are
// usually slower than a modern laptop, so treat results as a lower bound.

import { parseMarkdown } from "../src/email/markdown";
import { renderIssue } from "../src/email/render";
import { sampleIssue, sampleSettings } from "../src/email/sample";

const WARMUP_RUNS = 50;
const MEASURED_RUNS = 300;
const MICROSECONDS_PER_MS = 1000;
const MEDIAN = 0.5;
const P95 = 0.95;
const DECIMALS = 2;

type Task = () => Promise<void>;

const cpuMs = async (task: Task): Promise<number> => {
  const start = process.cpuUsage();

  await task();
  const { system, user } = process.cpuUsage(start);

  return (user + system) / MICROSECONDS_PER_MS;
};

const percentile = (sorted: number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
  0;

const measure = async (task: Task) => {
  for (let run = 0; run < WARMUP_RUNS; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- runs must not overlap
    await task();
  }

  const samples: number[] = [];

  for (let run = 0; run < MEASURED_RUNS; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- runs must not overlap
    samples.push(await cpuMs(task));
  }

  samples.sort((a, b) => a - b);

  return {
    max: samples.at(-1) ?? 0,
    median: percentile(samples, MEDIAN),
    p95: percentile(samples, P95),
  };
};

const format = (value: number): string => `${value.toFixed(DECIMALS)} ms`;

const parse: Task = async () => {
  await Promise.resolve(parseMarkdown(sampleIssue.body));
};

const render: Task = async () => {
  await renderIssue(sampleIssue, sampleSettings);
};

// Cold numbers come first, before anything has been JIT-compiled, which is
// what a freshly started isolate pays.
const coldParse = await cpuMs(parse);
const coldRender = await cpuMs(render);
const warmParse = await measure(parse);
const warmRender = await measure(render);

const result = await renderIssue(sampleIssue, sampleSettings);
const htmlBytes = result.ok ? new TextEncoder().encode(result.html).length : 0;

const lines = [
  `Sample issue: ${sampleIssue.body.length} chars of Markdown -> ${htmlBytes} bytes of HTML`,
  "",
  "                  cold      median    p95       max",
  `parse            ${format(coldParse).padEnd(10)}${format(warmParse.median).padEnd(10)}${format(warmParse.p95).padEnd(10)}${format(warmParse.max)}`,
  `parse + render   ${format(coldRender).padEnd(10)}${format(warmRender.median).padEnd(10)}${format(warmRender.p95).padEnd(10)}${format(warmRender.max)}`,
  "",
];

process.stdout.write(`${lines.join("\n")}\n`);
