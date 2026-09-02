import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.env.BENCHMARK_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const outputDir = path.resolve(process.env.BENCHMARK_OUTPUT_DIR || "./artifacts/benchmarks");
const dashboardToken = process.env.DASHBOARD_TOKEN?.trim() || "";
const headers = {
  "content-type": "application/json",
  ...(dashboardToken ? { "x-dashboard-token": dashboardToken } : {})
};
const repetitions = 2;
const concurrency = 4;

const prompts = [
  {
    id: "reasoning",
    label: "Arithmetic reasoning",
    maxTokens: 384,
    prompt: "A shop marks a $125 item down by 20%, then applies 10% sales tax to the discounted price. Return only valid JSON with exactly these keys: {\"answer\": number, \"explanation\": string}. What is the final price?",
    score(content) {
      const value = jsonObject(content);
      return value && Number(value.answer) === 110 && typeof value.explanation === "string" ? 1 : 0;
    }
  },
  {
    id: "coding",
    label: "Coding",
    maxTokens: 384,
    prompt: "Write a JavaScript function named sumEvenSquares(values) that accepts an array, ignores non-finite values, and returns the sum of the squares of only the even numbers. Return only the function code with no Markdown fence or explanation.",
    score(content) {
      const checks = [
        /function\s+sumEvenSquares|(?:const|let|var)\s+sumEvenSquares\s*=/,
        /Number\.isFinite/,
        /%\s*2|&\s*1/,
        /\*\s*(?:value|v|number|n)|Math\.pow\s*\([^,]+,\s*2\s*\)/
      ];
      const staticScore = checks.filter((check) => check.test(content)).length / checks.length;
      return Math.max(0, staticScore - (/```/.test(content) ? 0.1 : 0));
    }
  },
  {
    id: "structured",
    label: "Structured analysis",
    maxTokens: 256,
    prompt: "Analyze these request records: [{\"id\":\"a\",\"status\":200,\"latencyMs\":80},{\"id\":\"b\",\"status\":503,\"latencyMs\":40},{\"id\":\"c\",\"status\":201,\"latencyMs\":120},{\"id\":\"d\",\"status\":204,\"latencyMs\":160},{\"id\":\"e\",\"status\":429,\"latencyMs\":20}]. Return only valid JSON: {\"successCount\": number, \"failureCount\": number, \"averageSuccessLatencyMs\": number, \"failureIds\": string[]}. Treat 2xx as success.",
    score(content) {
      const value = jsonObject(content);
      return value && value.successCount === 3 && value.failureCount === 2 &&
        Number(value.averageSuccessLatencyMs) === 120 &&
        JSON.stringify(value.failureIds) === JSON.stringify(["b", "e"]) ? 1 : 0;
    }
  }
];

function jsonObject(content) {
  const text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function isFree(model) {
  if (!model.providerId || model.providerId === "agentrouter") return false;
  if (model.pricing?.input !== 0 || model.pricing?.output !== 0) return false;
  if (model.providerId !== "openrouter") return true;
  return model.upstreamId === "openrouter/free" || model.upstreamId?.endsWith(":free");
}

function isTextGeneration(model) {
  if (!model.protocols?.includes("openai") || (model.endpoints && !model.endpoints.includes("chat"))) return false;
  if (model.inputModalities?.length && !model.inputModalities.includes("text")) return false;
  if (model.outputModalities?.length && (model.outputModalities.length !== 1 || model.outputModalities[0] !== "text")) return false;
  if (model.providerId === "openrouter" && model.supportedParameters?.length) {
    return model.supportedParameters.some((parameter) => ["max_tokens", "temperature", "top_p", "tools", "reasoning"].includes(parameter));
  }
  return true;
}

function seededShuffle(values, seed = 0x51f15e) {
  const output = [...values];
  let state = seed >>> 0;
  for (let index = output.length - 1; index > 0; index--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function benchmarkCall(job) {
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(`${baseUrl}/admin/api/sandbox`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        purpose: "chat",
        requests: [{
          id: "benchmark",
          model: job.model.id,
          parameters: { maxTokens: job.prompt.maxTokens, temperature: 0, topP: 1 },
          messages: [{ role: "user", content: job.prompt.prompt }]
        }]
      })
    });
    const payload = await response.json().catch(() => ({}));
    const result = payload.results?.[0];
    const content = result?.content || "";
    const error = result?.error || (!response.ok ? payload.error || `HTTP ${response.status}` : null);
    return {
      modelId: job.model.id,
      modelName: job.model.displayName || job.model.id,
      provider: job.model.providerId,
      promptId: job.prompt.id,
      promptLabel: job.prompt.label,
      repetition: job.repetition,
      startedAt,
      success: !error && Boolean(content),
      capabilityScore: error ? 0 : job.prompt.score(content),
      content,
      reasoning: result?.reasoning || "",
      error: error ? String(error) : null,
      parameters: result?.parameters || { maxTokens: job.prompt.maxTokens, temperature: 0, topP: 1 },
      metrics: result?.metrics || null
    };
  } catch (error) {
    return {
      modelId: job.model.id, modelName: job.model.displayName || job.model.id, provider: job.model.providerId,
      promptId: job.prompt.id, promptLabel: job.prompt.label, repetition: job.repetition, startedAt,
      success: false, capabilityScore: 0, content: "", reasoning: "", error: error.name === "AbortError" ? "Benchmark request timed out after 180 seconds" : error.message,
      parameters: { maxTokens: job.prompt.maxTokens, temperature: 0, topP: 1 }, metrics: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

function aggregate(models, results) {
  const rows = models.map((model) => {
    const runs = results.filter((result) => result.modelId === model.id);
    const successful = runs.filter((result) => result.success);
    const promptScores = Object.fromEntries(prompts.map((prompt) => [prompt.id, average(runs.filter((run) => run.promptId === prompt.id).map((run) => run.capabilityScore)) ?? 0]));
    const consistency = average(prompts.map((prompt) => {
      const scores = runs.filter((run) => run.promptId === prompt.id).map((run) => run.capabilityScore);
      return scores.length === repetitions ? 1 - Math.abs(scores[0] - scores[1]) : 0;
    })) ?? 0;
    return {
      modelId: model.id,
      modelName: model.displayName || model.id,
      provider: model.providerId,
      contextTokens: model.contextTokens ?? null,
      attempts: runs.length,
      successes: successful.length,
      reliability: runs.length ? successful.length / runs.length : 0,
      capability: average(runs.map((run) => run.capabilityScore)) ?? 0,
      consistency,
      promptScores,
      medianLatencyMs: median(successful.map((run) => run.metrics?.latencyMs)),
      medianTtftMs: median(successful.map((run) => run.metrics?.ttftMs)),
      medianTokensPerSecond: median(successful.map((run) => run.metrics?.outputTokensPerSecond)),
      averageOutputTokens: average(successful.map((run) => run.metrics?.tokens?.output)),
      errors: Object.entries(Object.groupBy(runs.filter((run) => run.error), (run) => run.error)).map(([error, entries]) => ({ error, count: entries.length }))
    };
  });
  const successfulLatencies = rows.map((row) => row.medianLatencyMs).filter(Number.isFinite);
  const fastest = Math.min(...successfulLatencies);
  for (const row of rows) {
    const speed = row.medianLatencyMs ? Math.min(1, fastest / row.medianLatencyMs) : 0;
    row.overallScore = row.capability * 0.65 + row.reliability * 0.2 + speed * 0.1 + row.consistency * 0.05;
  }
  return rows.sort((left, right) => right.overallScore - left.overallScore || right.capability - left.capability);
}

function reportHtml(report) {
  const rows = report.models.map((model, index) => `<tr>
    <td>${index + 1}</td><td><strong>${escapeHtml(model.modelName)}</strong><small>${escapeHtml(model.modelId)}</small></td><td>${escapeHtml(model.provider)}</td>
    <td>${(model.overallScore * 100).toFixed(1)}</td><td>${(model.capability * 100).toFixed(1)}</td><td>${model.successes}/${model.attempts}</td>
    <td>${model.medianTtftMs == null ? "--" : Math.round(model.medianTtftMs)}</td><td>${model.medianLatencyMs == null ? "--" : Math.round(model.medianLatencyMs)}</td>
    <td>${model.medianTokensPerSecond == null ? "--" : model.medianTokensPerSecond.toFixed(1)}</td>
    <td>${(model.promptScores.reasoning * 100).toFixed(0)}</td><td>${(model.promptScores.coding * 100).toFixed(0)}</td><td>${(model.promptScores.structured * 100).toFixed(0)}</td>
  </tr>`).join("\n");
  const failures = report.models.filter((model) => model.reliability < 1).map((model) => `<li><strong>${escapeHtml(model.modelName)}</strong>: ${model.successes}/${model.attempts} successful${model.errors.length ? `; ${escapeHtml(model.errors.map((entry) => `${entry.count}x ${entry.error}`).join("; "))}` : ""}</li>`).join("") || "<li>No failures recorded.</li>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Free Model Benchmark</title><style>
  :root{color-scheme:dark;--bg:#090b0d;--panel:#111519;--line:#293139;--ink:#e8edf1;--muted:#8b9aa6;--acid:#b7ff3c;--cyan:#56d9ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}main{width:min(1500px,calc(100% - 32px));margin:34px auto 70px}h1{margin:0;font-size:clamp(28px,5vw,62px);letter-spacing:-.05em}h1 span{color:var(--acid)}.meta{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:24px 0}.card,section{border:1px solid var(--line);background:var(--panel);padding:18px}.card strong{display:block;color:var(--cyan);font-size:24px}.table{overflow:auto;border:1px solid var(--line)}table{width:100%;min-width:1120px;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid var(--line);text-align:right}th{position:sticky;top:0;background:#171c21;color:var(--muted);font-size:11px}td:nth-child(2),th:nth-child(2),td:nth-child(3),th:nth-child(3){text-align:left}td small{display:block;color:var(--muted);max-width:440px;overflow-wrap:anywhere}tr:nth-child(-n+3) td:first-child{color:var(--acid);font-weight:700}a{color:var(--cyan)}code{color:var(--acid)}li{margin:7px 0}@media(max-width:760px){.cards{grid-template-columns:1fr 1fr}main{width:min(100% - 18px,1500px)}}
  </style></head><body><main><p class="meta">ROUTETOK / EMPIRICAL REPORT</p><h1>FREE MODEL <span>BENCHMARK</span></h1><p class="meta">Generated ${escapeHtml(report.generatedAt)}. This is a small operational sample, not a definitive intelligence ranking.</p>
  <div class="cards"><div class="card"><span>MODELS</span><strong>${report.summary.models}</strong></div><div class="card"><span>REQUESTS</span><strong>${report.summary.requests}</strong></div><div class="card"><span>SUCCESS RATE</span><strong>${(report.summary.successRate * 100).toFixed(1)}%</strong></div><div class="card"><span>TEST DURATION</span><strong>${(report.summary.durationMs / 60000).toFixed(1)}m</strong></div></div>
  <section><h2>Methodology</h2><p>Every currently eligible free external text-generation model was tested on arithmetic reasoning, JavaScript coding, and exact structured analysis. Each prompt ran twice at temperature 0 and top-p 1, with a maximum of 256-384 output tokens. Four requests ran concurrently. Capability scoring uses deterministic answer checks and static code-shape checks; code was not executed. Overall score weights capability 65%, request reliability 20%, relative latency 10%, and repeat consistency 5%.</p><p>TTFT means first semantic stream output. Latency includes routing and generation. Free endpoints can be rate-limited, capacity-constrained, dynamically routed, or changed by providers; reruns may differ.</p><p><a href="/benchmarks/free-models.json">Download complete JSON results and raw outputs</a></p></section>
  <h2>Ranking</h2><div class="table"><table><thead><tr><th>#</th><th>Model</th><th>Provider</th><th>Overall</th><th>Capability</th><th>Success</th><th>TTFT ms</th><th>Latency ms</th><th>tok/s</th><th>Reason %</th><th>Code %</th><th>JSON %</th></tr></thead><tbody>${rows}</tbody></table></div>
  <section><h2>Availability Notes</h2><ul>${failures}</ul></section>
  <section><h2>Interpretation</h2><p>Prefer models with both strong capability and high reliability. A fast model with failed correctness checks is not necessarily useful, while a high-scoring model with frequent timeouts may be unsuitable as a primary route. Compare provider duplicates independently because hosting and serving stacks materially affect TTFT and reliability.</p></section>
  </main></body></html>`;
}

const benchmarkStarted = Date.now();
const statusResponse = await fetch(`${baseUrl}/admin/api/status`, { headers });
if (!statusResponse.ok) throw new Error(`Could not load catalog: HTTP ${statusResponse.status}`);
const status = await statusResponse.json();
const disabled = new Set(status.config.disabledModels || []);
const configured = new Set((status.providers || []).filter((provider) => provider.configured).map((provider) => provider.providerId));
const models = status.catalog.models.filter((model) => configured.has(model.providerId) && !disabled.has(model.id) && isFree(model) && isTextGeneration(model));
const jobs = seededShuffle(models.flatMap((model) => prompts.flatMap((prompt) => Array.from({ length: repetitions }, (_, repetition) => ({ model, prompt, repetition: repetition + 1 })))));
console.log(`Benchmarking ${models.length} free models with ${jobs.length} calls at concurrency ${concurrency}.`);

const results = [];
let cursor = 0;
let completed = 0;
await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
  while (true) {
    const index = cursor++;
    if (index >= jobs.length) return;
    const result = await benchmarkCall(jobs[index]);
    results.push(result);
    completed += 1;
    console.log(`[${completed}/${jobs.length}] worker=${worker + 1} ${result.modelId} ${result.promptId}#${result.repetition} ${result.success ? `ok score=${result.capabilityScore.toFixed(2)} ${result.metrics?.latencyMs ?? "--"}ms` : `FAIL ${result.error}`}`);
  }
}));

const modelRows = aggregate(models, results);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmarkStartedAt: new Date(benchmarkStarted).toISOString(),
  methodology: { repetitions, concurrency, prompts: prompts.map(({ score: _score, ...prompt }) => prompt), timeoutMs: 180_000, temperature: 0, topP: 1 },
  summary: {
    models: models.length,
    requests: results.length,
    successes: results.filter((result) => result.success).length,
    successRate: results.length ? results.filter((result) => result.success).length / results.length : 0,
    durationMs: Date.now() - benchmarkStarted,
    providers: Object.fromEntries(Object.entries(Object.groupBy(models, (model) => model.providerId)).map(([provider, entries]) => [provider, entries.length]))
  },
  models: modelRows,
  runs: results.sort((left, right) => left.modelId.localeCompare(right.modelId) || left.promptId.localeCompare(right.promptId) || left.repetition - right.repetition)
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDir, "free-model-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 }),
  writeFile(path.join(outputDir, "free-model-benchmark.html"), reportHtml(report), { mode: 0o644 })
]);
console.log(`Report written to ${outputDir}. Top model: ${modelRows[0]?.modelId ?? "none"}.`);
