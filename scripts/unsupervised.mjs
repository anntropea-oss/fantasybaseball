import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "logs", "snapshots.jsonl");
const OUT_JSON = path.join(ROOT, "logs", "unsupervised.json");
const OUT_MD = path.join(ROOT, "logs", "unsupervised-report.md");

function parseArgs(argv) {
  const args = {
    days: 30,
    mode: "daily",
    horizonDays: 1,
    kMin: 2,
    kMax: 6,
    write: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--days") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.days = Math.floor(v);
      i += 1;
    } else if (a === "--daily") {
      args.mode = "daily";
    } else if (a === "--all-runs") {
      args.mode = "all";
    } else if (a === "--horizon") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.horizonDays = Math.floor(v);
      i += 1;
    } else if (a === "--k-min") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v >= 2) args.kMin = Math.floor(v);
      i += 1;
    } else if (a === "--k-max") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v >= 2) args.kMax = Math.floor(v);
      i += 1;
    } else if (a === "--no-write") {
      args.write = false;
    }
  }
  return args;
}

function parseIsoDate(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return new Date(Date.UTC(y, mo - 1, d));
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "object" && value && "value" in value) return toNumber(value.value);
  return null;
}

function daysBetweenUtc(a, b) {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function pickSnapshots(snaps, mode) {
  if (mode === "all") {
    return snaps
      .slice()
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  }
  const byDate = new Map();
  snaps.forEach((s) => {
    if (!s?.date || !s?.timestamp) return;
    const prev = byDate.get(s.date);
    if (!prev || String(s.timestamp) > String(prev.timestamp)) byDate.set(s.date, s);
  });
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function sumPoints(snapshot) {
  return (snapshot?.categories || []).reduce((sum, c) => sum + (toNumber(c.points) ?? 0), 0);
}

function sumFocusPoints(snapshot) {
  const keys = snapshot?.focusTargets || snapshot?.targets || [];
  if (!Array.isArray(keys) || keys.length === 0) return 0;
  const by = new Map((snapshot.categories || []).map((c) => [c.key, c]));
  return keys.reduce((sum, k) => sum + (toNumber(by.get(k)?.points) ?? 0), 0);
}

function featureConfig(name, options) {
  return { name, ...options };
}

function zscoreColumns(X) {
  const n = X.length;
  const p = X[0].length;
  const means = Array.from({ length: p }, () => 0);
  const stds = Array.from({ length: p }, () => 1);
  for (let j = 0; j < p; j += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += X[i][j];
    means[j] = sum / n;
  }
  for (let j = 0; j < p; j += 1) {
    let ss = 0;
    for (let i = 0; i < n; i += 1) ss += Math.pow(X[i][j] - means[j], 2);
    stds[j] = Math.sqrt(ss / n) || 1;
  }
  const Z = X.map((row) => row.map((v, j) => (v - means[j]) / stds[j]));
  return { Z, means, stds };
}

function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.pow(a[i] - b[i], 2);
  return s;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function kmeans(Z, k, { nInit = 20, maxIter = 80, seed = 42 } = {}) {
  const n = Z.length;
  const p = Z[0].length;
  const rngBase = mulberry32(seed);

  let best = null;
  for (let init = 0; init < nInit; init += 1) {
    const rng = mulberry32(Math.floor(rngBase() * 1e9));
    const centers = [];
    const used = new Set();
    while (centers.length < k) {
      const idx = Math.floor(rng() * n);
      if (used.has(idx)) continue;
      used.add(idx);
      centers.push(Z[idx].slice());
    }

    let labels = Array.from({ length: n }, () => 0);
    for (let iter = 0; iter < maxIter; iter += 1) {
      let changed = 0;
      // assign
      for (let i = 0; i < n; i += 1) {
        let bestJ = 0;
        let bestD = Infinity;
        for (let j = 0; j < k; j += 1) {
          const d = dist2(Z[i], centers[j]);
          if (d < bestD) {
            bestD = d;
            bestJ = j;
          }
        }
        if (labels[i] !== bestJ) {
          labels[i] = bestJ;
          changed += 1;
        }
      }
      // recompute centers
      const sums = Array.from({ length: k }, () => Array.from({ length: p }, () => 0));
      const counts = Array.from({ length: k }, () => 0);
      for (let i = 0; i < n; i += 1) {
        const j = labels[i];
        counts[j] += 1;
        for (let d = 0; d < p; d += 1) sums[j][d] += Z[i][d];
      }
      for (let j = 0; j < k; j += 1) {
        if (counts[j] === 0) continue;
        for (let d = 0; d < p; d += 1) centers[j][d] = sums[j][d] / counts[j];
      }
      if (changed === 0) break;
    }

    // inertia
    let inertia = 0;
    for (let i = 0; i < n; i += 1) inertia += dist2(Z[i], centers[labels[i]]);
    if (!best || inertia < best.inertia) best = { labels, centers, inertia };
  }
  return best;
}

function silhouetteScore(Z, labels, k) {
  const n = Z.length;
  const clusters = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i += 1) clusters[labels[i]].push(i);
  const dists = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = Math.sqrt(dist2(Z[i], Z[j]));
      dists[i][j] = d;
      dists[j][i] = d;
    }
  }

  const s = [];
  for (let i = 0; i < n; i += 1) {
    const ci = labels[i];
    const own = clusters[ci];
    const a =
      own.length <= 1
        ? 0
        : own.reduce((sum, idx) => sum + (idx === i ? 0 : dists[i][idx]), 0) /
          (own.length - 1);
    let b = Infinity;
    for (let c = 0; c < k; c += 1) {
      if (c === ci) continue;
      const other = clusters[c];
      if (other.length === 0) continue;
      const avg =
        other.reduce((sum, idx) => sum + dists[i][idx], 0) / other.length;
      if (avg < b) b = avg;
    }
    const denom = Math.max(a, b) || 1;
    s.push((b - a) / denom);
  }
  return s.reduce((sum, v) => sum + v, 0) / s.length;
}

function etaSquared(groups, y) {
  const n = y.length;
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  const ssTot = y.reduce((s, v) => s + Math.pow(v - yMean, 2), 0);
  const byGroup = new Map();
  y.forEach((v, i) => {
    const g = groups[i];
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(v);
  });
  let ssBetween = 0;
  byGroup.forEach((vals) => {
    const m = vals.reduce((s, v) => s + v, 0) / vals.length;
    ssBetween += vals.length * Math.pow(m - yMean, 2);
  });
  return ssTot > 0 ? ssBetween / ssTot : 0;
}

function buildMatrix(filtered, cfg) {
  const catKeys = filtered[0]?.categories?.map((c) => c.key) || [];
  const rows = [];
  const labels = [];
  for (let i = 0; i < filtered.length; i += 1) {
    const s = filtered[i];
    const v = [];
    if (cfg.includeMeta) {
      v.push(toNumber(s.overallRank) ?? 0);
      v.push(sumPoints(s));
      v.push(toNumber(s.seasonProgress) ?? 0);
      const ip = toNumber(s.ipValue);
      const ipCap = toNumber(s.ipCap);
      const prog = toNumber(s.seasonProgress);
      const paceDen = ipCap && prog ? ipCap * prog : null;
      v.push(ip !== null && paceDen ? ip / paceDen : 0);
    }
    if (cfg.includeCatPoints) {
      const by = new Map((s.categories || []).map((c) => [c.key, c]));
      catKeys.forEach((k) => v.push(toNumber(by.get(k)?.points) ?? 0));
    }
    if (cfg.includeActions) {
      const a = s.actions || {};
      const adds =
        (a.addBatting?.length || 0) + (a.addPitching?.length || 0) + (a.add?.length || 0);
      const drops = a.drop?.length || 0;
      const starts = a.start?.length || 0;
      v.push(adds, drops, starts);
    }
    if (cfg.includeTrend && i > 0) {
      const prev = filtered[i - 1];
      const prevBy = new Map((prev.categories || []).map((c) => [c.key, c]));
      const curBy = new Map((s.categories || []).map((c) => [c.key, c]));
      catKeys.forEach((k) => {
        const dp = (toNumber(curBy.get(k)?.points) ?? 0) - (toNumber(prevBy.get(k)?.points) ?? 0);
        v.push(dp);
      });
    } else if (cfg.includeTrend) {
      // first row: zeros
      catKeys.forEach(() => v.push(0));
    }
    rows.push(v);
    labels.push(s.date);
  }
  return { X: rows, labels, catKeys };
}

function experiment(filtered, cfg, args) {
  const { X, labels } = buildMatrix(filtered, cfg);
  const { Z } = zscoreColumns(X);
  const results = [];
  for (let k = args.kMin; k <= args.kMax; k += 1) {
    const km = kmeans(Z, k, { nInit: 30, seed: 1337 });
    const sil = silhouetteScore(Z, km.labels, k);
    results.push({ k, sil, inertia: km.inertia, labels: km.labels });
  }
  results.sort((a, b) => b.sil - a.sil);
  const best = results[0];

  // post-hoc outcome separation: future delta total points per day
  const horizon = args.horizonDays;
  const y = [];
  const g = [];
  for (let i = 0; i + horizon < filtered.length; i += 1) {
    const a = filtered[i];
    const b = filtered[i + horizon];
    const aD = parseIsoDate(a.date);
    const bD = parseIsoDate(b.date);
    const gap = aD && bD ? Math.max(1, daysBetweenUtc(aD, bD)) : horizon;
    y.push((sumPoints(b) - sumPoints(a)) / gap);
    g.push(best.labels[i]);
  }
  const separation = etaSquared(g, y);

  // cluster summaries
  const clusterCounts = {};
  best.labels.forEach((c) => {
    clusterCounts[c] = (clusterCounts[c] || 0) + 1;
  });
  const clusters = Object.keys(clusterCounts)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((c) => ({ id: c, count: clusterCounts[c] }));

  return {
    config: cfg.name,
    bestK: best.k,
    silhouette: best.sil,
    separationEta2: separation,
    assignments: labels.map((date, i) => ({ date, cluster: best.labels[i] })),
    clusters,
  };
}

const args = parseArgs(process.argv.slice(2));
const snaps = readJsonl(SNAPSHOT_PATH);
const ordered = pickSnapshots(snaps, args.mode);
if (ordered.length < 8) {
  console.log("Not enough snapshots for unsupervised experiments.");
  process.exit(0);
}

const maxDate = ordered.map((s) => s.date).sort().at(-1);
const maxDateObj = parseIsoDate(maxDate);
const cutoff = new Date(maxDateObj.getTime() - (args.days - 1) * 24 * 60 * 60 * 1000);
const filtered = ordered.filter((s) => {
  const d = parseIsoDate(s.date);
  return d && d >= cutoff;
});

const configs = [
  featureConfig("state_points", { includeMeta: true, includeCatPoints: true, includeActions: false, includeTrend: false }),
  featureConfig("state_points_actions", { includeMeta: true, includeCatPoints: true, includeActions: true, includeTrend: false }),
  featureConfig("state_points_trend", { includeMeta: true, includeCatPoints: true, includeActions: false, includeTrend: true }),
  featureConfig("state_points_trend_actions", { includeMeta: true, includeCatPoints: true, includeActions: true, includeTrend: true }),
];

const runs = configs.map((cfg) => experiment(filtered, cfg, args));
const best = runs.slice().sort((a, b) => b.separationEta2 - a.separationEta2)[0];

const summary = {
  generatedAt: new Date().toISOString(),
  window: { from: filtered[0].date, to: filtered.at(-1).date, days: args.days, mode: args.mode },
  horizonDays: args.horizonDays,
  selectionMetric: "eta_squared(delta_total_points_per_day ~ cluster)",
  best,
  runs: runs.map((r) => ({
    config: r.config,
    bestK: r.bestK,
    silhouette: r.silhouette,
    separationEta2: r.separationEta2,
    clusters: r.clusters,
  })),
};

if (args.write) {
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
  const lines = [];
  lines.push(`# Unsupervised Experiments`);
  lines.push(``);
  lines.push(`Window: ${summary.window.from} -> ${summary.window.to} (${summary.window.days} days, mode=${summary.window.mode})`);
  lines.push(`Horizon: ${summary.horizonDays} day(s)`);
  lines.push(`Metric: ${summary.selectionMetric}`);
  lines.push(``);
  lines.push(`## Best Configuration`);
  lines.push(`- config: ${best.config}`);
  lines.push(`- bestK: ${best.bestK}`);
  lines.push(`- silhouette: ${best.silhouette.toFixed(3)}`);
  lines.push(`- eta^2: ${best.separationEta2.toFixed(3)}`);
  lines.push(``);
  lines.push(`## All Runs`);
  runs
    .slice()
    .sort((a, b) => b.separationEta2 - a.separationEta2)
    .forEach((r) => {
      lines.push(`- ${r.config}: bestK=${r.bestK}, silhouette=${r.silhouette.toFixed(3)}, eta^2=${r.separationEta2.toFixed(3)}`);
    });
  lines.push(``);
  fs.writeFileSync(OUT_MD, lines.join("\n") + "\n");
}

console.log(`Best: ${best.config} (k=${best.bestK}, silhouette=${best.silhouette.toFixed(3)}, eta^2=${best.separationEta2.toFixed(3)})`);

