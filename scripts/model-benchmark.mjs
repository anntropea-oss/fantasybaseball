import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "logs", "snapshots.jsonl");
const OUT_JSON = path.join(ROOT, "logs", "model-benchmark.json");

function parseArgs(argv) {
  const args = { days: 90, mode: "daily", topN: 3, minTrain: 12, pcaK: 5, trees: 60, maxDepth: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--days") { const v = Number(argv[i + 1]); if (Number.isFinite(v) && v > 0) args.days = Math.floor(v); i += 1; }
    else if (a === "--all-runs") args.mode = "all";
    else if (a === "--daily") args.mode = "daily";
    else if (a === "--top") { const v = Number(argv[i + 1]); if (Number.isFinite(v) && v > 0) args.topN = Math.floor(v); i += 1; }
    else if (a === "--min-train") { const v = Number(argv[i + 1]); if (Number.isFinite(v) && v > 5) args.minTrain = Math.floor(v); i += 1; }
  }
  return args;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function parseIsoDate(dateStr) { if (!dateStr) return null; const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim()); if (!m) return null; return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); }
function pickSnapshots(snaps, mode) {
  if (mode === "all") return snaps.slice().sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const byDate = new Map();
  snaps.forEach((s) => { if (!s?.date || !s?.timestamp) return; const p = byDate.get(s.date); if (!p || String(s.timestamp) > String(p.timestamp)) byDate.set(s.date, s); });
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
function toNumber(v) { if (v === null || v === undefined) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : null; } if (typeof v === "object" && v && "value" in v) return toNumber(v.value); return null; }
function catMap(s, field = "points") { const m = new Map(); (s?.categories || []).forEach((c) => m.set(c.key, toNumber(c[field]) ?? 0)); return m; }
function sumPoints(s) { return [...catMap(s, "points").values()].reduce((a, b) => a + b, 0); }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]; return s; }
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function mulberry32(seed) { let t = seed >>> 0; return () => { t += 0x6d2b79f5; let x = t; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }

function buildFeatures(s, keys) {
  const p = catMap(s, "points");
  const v = catMap(s, "value");
  const rank = toNumber(s.overallRank) ?? 0;
  const season = toNumber(s.seasonProgress) ?? 0;
  const ip = toNumber(s.ipValue) ?? 0;
  const ipCap = toNumber(s.ipCap) ?? 0;
  const gp = toNumber(s.gpValue) ?? 0;
  const gpCap = toNumber(s.gpCap) ?? 0;
  const ipPace = season > 0 && ipCap > 0 ? ip / (ipCap * season) : 0;
  const gpPace = season > 0 && gpCap > 0 ? gp / (gpCap * season) : 0;
  const base = [rank, sumPoints(s), season, ipPace, gpPace];
  keys.forEach((k) => base.push(p.get(k) ?? 0));
  keys.forEach((k) => base.push(v.get(k) ?? 0));
  return base;
}

function standardizeFit(X) {
  const n = X.length, d = X[0].length;
  const mu = Array(d).fill(0), sd = Array(d).fill(1);
  for (let j = 0; j < d; j += 1) mu[j] = X.reduce((s, r) => s + r[j], 0) / n;
  for (let j = 0; j < d; j += 1) sd[j] = Math.sqrt(X.reduce((s, r) => s + (r[j] - mu[j]) ** 2, 0) / n) || 1;
  return { mu, sd };
}
function standardizeApply(X, z) { return X.map((r) => r.map((v, j) => (v - z.mu[j]) / z.sd[j])); }

function ridgeTrain(X, y, { lr = 0.03, iters = 600, alpha = 0.8 } = {}) {
  const n = X.length, d = X[0].length;
  const w = Array(d).fill(0); let b = 0;
  for (let it = 0; it < iters; it += 1) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i += 1) {
      const e = dot(w, X[i]) + b - y[i];
      gb += e;
      for (let j = 0; j < d; j += 1) gw[j] += e * X[i][j];
    }
    for (let j = 0; j < d; j += 1) w[j] -= lr * ((gw[j] / n) + alpha * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}
function ridgePred(model, x) { return dot(model.w, x) + model.b; }

function pcaFit(X, k, seed = 7) {
  const n = X.length, d = X[0].length;
  const C = Array.from({ length: d }, () => Array(d).fill(0));
  for (let i = 0; i < n; i += 1) for (let a = 0; a < d; a += 1) for (let b = a; b < d; b += 1) C[a][b] += X[i][a] * X[i][b];
  for (let a = 0; a < d; a += 1) for (let b = a; b < d; b += 1) { C[a][b] /= Math.max(1, n - 1); C[b][a] = C[a][b]; }
  const comps = []; const rng = mulberry32(seed);
  function matVec(M, v) { return M.map((row) => dot(row, v)); }
  function norm(v) { return Math.sqrt(dot(v, v)) || 1; }
  function deflate(M, v, lam) { for (let i = 0; i < d; i += 1) for (let j = 0; j < d; j += 1) M[i][j] -= lam * v[i] * v[j]; }
  const M = C.map((r) => r.slice());
  const kk = Math.min(k, d);
  for (let c = 0; c < kk; c += 1) {
    let v = Array.from({ length: d }, () => rng() - 0.5);
    for (let it = 0; it < 80; it += 1) { const mv = matVec(M, v); const nm = norm(mv); v = mv.map((x) => x / nm); }
    const mv = matVec(M, v); const lam = dot(v, mv);
    comps.push(v.slice());
    deflate(M, v, lam);
  }
  return { comps };
}
function pcaProject(X, pca) { return X.map((r) => pca.comps.map((c) => dot(r, c))); }

function treeTrain(X, y, { maxDepth = 3, minLeaf = 4, mtry = null, rng = Math.random }) {
  const d = X[0].length; const feats = [...Array(d).keys()];
  const pickFeats = () => {
    const m = mtry || Math.max(1, Math.floor(Math.sqrt(d))); const arr = feats.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr.slice(0, m);
  };
  function mse(vals) { if (!vals.length) return 0; const m = mean(vals); return vals.reduce((s, v) => s + (v - m) ** 2, 0); }
  function build(idxs, depth) {
    const vals = idxs.map((i) => y[i]);
    const pred = mean(vals);
    if (depth >= maxDepth || idxs.length <= minLeaf * 2) return { leaf: true, pred };
    let best = null;
    for (const f of pickFeats()) {
      const xs = idxs.map((i) => X[i][f]).sort((a, b) => a - b);
      const cands = [xs[Math.floor(xs.length * 0.3)], xs[Math.floor(xs.length * 0.5)], xs[Math.floor(xs.length * 0.7)]].filter((v) => Number.isFinite(v));
      for (const thr of cands) {
        const L = idxs.filter((i) => X[i][f] <= thr); const R = idxs.filter((i) => X[i][f] > thr);
        if (L.length < minLeaf || R.length < minLeaf) continue;
        const loss = mse(L.map((i) => y[i])) + mse(R.map((i) => y[i]));
        if (!best || loss < best.loss) best = { f, thr, L, R, loss };
      }
    }
    if (!best) return { leaf: true, pred };
    return { leaf: false, f: best.f, thr: best.thr, left: build(best.L, depth + 1), right: build(best.R, depth + 1) };
  }
  return build([...Array(X.length).keys()], 0);
}
function treePred(node, x) { let n = node; while (!n.leaf) n = x[n.f] <= n.thr ? n.left : n.right; return n.pred; }
function forestTrain(X, y, { trees = 60, maxDepth = 3, seed = 11 } = {}) {
  const rng = mulberry32(seed); const models = [];
  for (let t = 0; t < trees; t += 1) {
    const bx = [], by = [];
    for (let i = 0; i < X.length; i += 1) { const k = Math.floor(rng() * X.length); bx.push(X[k]); by.push(y[k]); }
    models.push(treeTrain(bx, by, { maxDepth, minLeaf: 4, rng }));
  }
  return models;
}
function forestPred(models, x) { return mean(models.map((m) => treePred(m, x))); }

function topNByScores(scores, n) { return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k); }
function realizedGain(a, b, targets) {
  const pa = catMap(a, "points"), pb = catMap(b, "points");
  return targets.reduce((s, k) => s + ((pb.get(k) ?? 0) - (pa.get(k) ?? 0)), 0);
}
function evaluateRows(rows) {
  const g = rows.map((r) => r.gain); const m = mean(g); return { meanGain: m, wins: g.filter((x) => x > 0).length, nonNegRate: g.filter((x) => x >= 0).length / Math.max(1, g.length), n: g.length };
}

const args = parseArgs(process.argv.slice(2));
const snaps = pickSnapshots(readJsonl(SNAPSHOT_PATH), args.mode);
if (snaps.length < args.minTrain + 3) { console.log("Not enough snapshots."); process.exit(0); }
const maxDate = snaps.map((s) => s.date).sort().at(-1);
const cutoff = new Date(parseIsoDate(maxDate).getTime() - (args.days - 1) * 86400000);
const filtered = snaps.filter((s) => { const d = parseIsoDate(s.date); return d && d >= cutoff; });

const catKeys = filtered[0]?.categories?.map((c) => c.key) || [];
const Xall = filtered.map((s) => buildFeatures(s, catKeys));

const methods = {
  baseline: [],
  ridge: [],
  pca_ridge: [],
  forest: [],
};

for (let t = args.minTrain; t < filtered.length - 1; t += 1) {
  const trainX = Xall.slice(0, t);
  const z = standardizeFit(trainX);
  const ZX = standardizeApply(trainX, z);
  const zNow = standardizeApply([Xall[t]], z)[0];

  const baseTargets = (filtered[t].focusTargets || filtered[t].targets || []).slice(0, args.topN);
  if (baseTargets.length) {
    methods.baseline.push({ date: filtered[t].date, gain: realizedGain(filtered[t], filtered[t + 1], baseTargets), targets: baseTargets });
  }

  const ridgeScores = new Map();
  const pcaScores = new Map();
  const forestScores = new Map();

  const pca = pcaFit(ZX, args.pcaK, 42 + t);
  const PX = pcaProject(ZX, pca);
  const pNow = pcaProject([zNow], pca)[0];

  for (const k of catKeys) {
    const y = [];
    for (let i = 0; i < t; i += 1) {
      const a = catMap(filtered[i], "points"); const b = catMap(filtered[i + 1], "points");
      y.push((b.get(k) ?? 0) - (a.get(k) ?? 0));
    }
    const ridge = ridgeTrain(ZX, y, { alpha: 0.9 });
    ridgeScores.set(k, ridgePred(ridge, zNow));

    const pr = ridgeTrain(PX, y, { alpha: 0.6 });
    pcaScores.set(k, ridgePred(pr, pNow));

    const forest = forestTrain(ZX, y, { trees: args.trees, maxDepth: args.maxDepth, seed: 99 + t });
    forestScores.set(k, forestPred(forest, zNow));
  }

  const ridgeTargets = topNByScores(ridgeScores, args.topN);
  const pcaTargets = topNByScores(pcaScores, args.topN);
  const forestTargets = topNByScores(forestScores, args.topN);

  methods.ridge.push({ date: filtered[t].date, gain: realizedGain(filtered[t], filtered[t + 1], ridgeTargets), targets: ridgeTargets });
  methods.pca_ridge.push({ date: filtered[t].date, gain: realizedGain(filtered[t], filtered[t + 1], pcaTargets), targets: pcaTargets });
  methods.forest.push({ date: filtered[t].date, gain: realizedGain(filtered[t], filtered[t + 1], forestTargets), targets: forestTargets });
}

const summary = {
  generatedAt: new Date().toISOString(),
  window: { from: filtered[0]?.date, to: filtered.at(-1)?.date, days: args.days, mode: args.mode },
  params: args,
  categoryKeys: catKeys,
  results: Object.fromEntries(Object.entries(methods).map(([k, rows]) => [k, evaluateRows(rows)])),
  deltaVsBaseline: {},
};
for (const k of ["ridge", "pca_ridge", "forest"]) {
  summary.deltaVsBaseline[k] = summary.results[k].meanGain - summary.results.baseline.meanGain;
}

fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
console.log("Model benchmark complete.");
console.log(`Window: ${summary.window.from} -> ${summary.window.to}`);
for (const [k, v] of Object.entries(summary.results)) {
  console.log(`${k}: meanGain=${v.meanGain.toFixed(3)} n=${v.n} nonNegRate=${(v.nonNegRate * 100).toFixed(1)}%`);
}
for (const [k, v] of Object.entries(summary.deltaVsBaseline)) {
  console.log(`delta_vs_baseline_${k}: ${v.toFixed(3)}`);
}
console.log(`Report: ${OUT_JSON}`);
