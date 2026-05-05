import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "logs", "snapshots.jsonl");
const OUT_JSON = path.join(ROOT, "logs", "unsupervised-policy-report.json");
const OUT_MD = path.join(ROOT, "logs", "unsupervised-policy-report.md");

function parseArgs(argv) {
  const args = {
    days: 60,
    mode: "daily",
    topN: 3,
    minTrain: 10,
    minPts: 3,
    epsPercentile: 0.75,
    knnK: 5,
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
    } else if (a === "--top") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.topN = Math.floor(v);
      i += 1;
    } else if (a === "--min-train") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v >= 6) args.minTrain = Math.floor(v);
      i += 1;
    } else if (a === "--min-pts") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v >= 2) args.minPts = Math.floor(v);
      i += 1;
    } else if (a === "--eps-percentile") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0.1 && v < 0.99) args.epsPercentile = v;
      i += 1;
    } else if (a === "--knn-k") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v >= 1) args.knnK = Math.floor(v);
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
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function pickSnapshots(snaps, mode) {
  if (mode === "all") {
    return snaps.slice().sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  }
  const byDate = new Map();
  snaps.forEach((s) => {
    if (!s?.date || !s?.timestamp) return;
    const prev = byDate.get(s.date);
    if (!prev || String(s.timestamp) > String(prev.timestamp)) byDate.set(s.date, s);
  });
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
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

function sumPoints(snapshot) {
  return (snapshot?.categories || []).reduce((s, c) => s + (toNumber(c.points) ?? 0), 0);
}

function categoryPointsMap(snapshot) {
  const map = new Map();
  (snapshot?.categories || []).forEach((c) => {
    if (!c?.key) return;
    map.set(c.key, toNumber(c.points) ?? 0);
  });
  return map;
}

function categoryPointDeltas(a, b, categoryKeys) {
  const pa = categoryPointsMap(a);
  const pb = categoryPointsMap(b);
  const out = new Map();
  categoryKeys.forEach((k) => out.set(k, (pb.get(k) ?? 0) - (pa.get(k) ?? 0)));
  return out;
}

function buildStateVector(snapshot, categoryKeys) {
  const by = categoryPointsMap(snapshot);
  const rank = toNumber(snapshot?.overallRank) ?? 0;
  const season = toNumber(snapshot?.seasonProgress) ?? 0;
  const ip = toNumber(snapshot?.ipValue) ?? 0;
  const ipCap = toNumber(snapshot?.ipCap) ?? 0;
  const ipPace = season > 0 && ipCap > 0 ? ip / (ipCap * season) : 0;
  const vec = [rank, sumPoints(snapshot), season, ipPace];
  categoryKeys.forEach((k) => vec.push(by.get(k) ?? 0));
  return vec;
}

function fitScaler(X) {
  const n = X.length;
  const p = X[0].length;
  const means = Array.from({ length: p }, () => 0);
  const stds = Array.from({ length: p }, () => 1);
  for (let j = 0; j < p; j += 1) {
    means[j] = X.reduce((s, row) => s + row[j], 0) / n;
  }
  for (let j = 0; j < p; j += 1) {
    const v = X.reduce((s, row) => s + Math.pow(row[j] - means[j], 2), 0) / n;
    stds[j] = Math.sqrt(v) || 1;
  }
  return { means, stds };
}

function transform(X, scaler) {
  return X.map((row) => row.map((v, j) => (v - scaler.means[j]) / scaler.stds[j]));
}

function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.pow(a[i] - b[i], 2);
  return s;
}

function percentile(values, q) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[idx];
}

function chooseEps(Z, minPts, q) {
  if (Z.length <= minPts) return 1;
  const kDists = [];
  for (let i = 0; i < Z.length; i += 1) {
    const ds = [];
    for (let j = 0; j < Z.length; j += 1) {
      if (i === j) continue;
      ds.push(Math.sqrt(dist2(Z[i], Z[j])));
    }
    ds.sort((a, b) => a - b);
    kDists.push(ds[Math.min(minPts - 1, ds.length - 1)] ?? ds[ds.length - 1] ?? 0);
  }
  return percentile(kDists, q);
}

function dbscan(Z, eps, minPts) {
  const n = Z.length;
  const labels = Array.from({ length: n }, () => -99); // -99 unvisited, -1 noise
  let clusterId = 0;

  function regionQuery(i) {
    const out = [];
    for (let j = 0; j < n; j += 1) {
      if (Math.sqrt(dist2(Z[i], Z[j])) <= eps) out.push(j);
    }
    return out;
  }

  function expandCluster(i, neighbors, cid) {
    labels[i] = cid;
    const queue = neighbors.slice();
    for (let q = 0; q < queue.length; q += 1) {
      const j = queue[q];
      if (labels[j] === -1) labels[j] = cid;
      if (labels[j] !== -99) continue;
      labels[j] = cid;
      const nbs = regionQuery(j);
      if (nbs.length >= minPts) {
        nbs.forEach((x) => {
          if (!queue.includes(x)) queue.push(x);
        });
      }
    }
  }

  for (let i = 0; i < n; i += 1) {
    if (labels[i] !== -99) continue;
    const neighbors = regionQuery(i);
    if (neighbors.length < minPts) {
      labels[i] = -1;
      continue;
    }
    expandCluster(i, neighbors, clusterId);
    clusterId += 1;
  }

  return { labels, clusterCount: clusterId };
}

function assignClusterForPoint(z, Ztrain, labelsTrain, eps) {
  let bestIdx = -1;
  let bestD = Infinity;
  for (let i = 0; i < Ztrain.length; i += 1) {
    if (labelsTrain[i] < 0) continue;
    const d = Math.sqrt(dist2(z, Ztrain[i]));
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  if (bestIdx === -1 || bestD > eps) return -1;
  return labelsTrain[bestIdx];
}

function topKeysFromMap(scoreMap, n) {
  return [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function recommendTargetsUnsupervised({ t, X, snapshots, categoryKeys, topN, minPts, epsPercentile, knnK }) {
  const trainX = X.slice(0, t);
  const scaler = fitScaler(trainX);
  const Ztrain = transform(trainX, scaler);
  const zNow = transform([X[t]], scaler)[0];
  const eps = chooseEps(Ztrain, minPts, epsPercentile);
  const clusterRes = dbscan(Ztrain, eps, minPts);
  const assigned = assignClusterForPoint(zNow, Ztrain, clusterRes.labels, eps);

  const deltasByIndex = [];
  for (let i = 0; i < t; i += 1) {
    const d = categoryPointDeltas(snapshots[i], snapshots[i + 1], categoryKeys);
    deltasByIndex.push(d);
  }

  let method = "cluster";
  let scores = new Map(categoryKeys.map((k) => [k, 0]));
  let support = 0;

  if (assigned >= 0) {
    for (let i = 0; i < clusterRes.labels.length; i += 1) {
      if (clusterRes.labels[i] !== assigned) continue;
      support += 1;
      const d = deltasByIndex[i];
      categoryKeys.forEach((k) => scores.set(k, (scores.get(k) ?? 0) + (d.get(k) ?? 0)));
    }
    if (support > 0) categoryKeys.forEach((k) => scores.set(k, (scores.get(k) ?? 0) / support));
  }

  if (assigned < 0 || support < 3) {
    method = "knn";
    const dists = [];
    for (let i = 0; i < Ztrain.length; i += 1) {
      dists.push({ i, d: Math.sqrt(dist2(zNow, Ztrain[i])) });
    }
    dists.sort((a, b) => a.d - b.d);
    const picks = dists.slice(0, Math.min(knnK, dists.length));
    support = picks.length;
    scores = new Map(categoryKeys.map((k) => [k, 0]));
    picks.forEach(({ i }) => {
      const d = deltasByIndex[i];
      categoryKeys.forEach((k) => scores.set(k, (scores.get(k) ?? 0) + (d.get(k) ?? 0)));
    });
    if (support > 0) categoryKeys.forEach((k) => scores.set(k, (scores.get(k) ?? 0) / support));
  }

  return {
    targets: topKeysFromMap(scores, topN),
    method,
    support,
    eps,
    clusters: clusterRes.clusterCount,
  };
}

function realizedGainForTargets(snapshotA, snapshotB, targets) {
  const d = categoryPointDeltas(snapshotA, snapshotB, targets);
  return targets.reduce((s, k) => s + (d.get(k) ?? 0), 0);
}

const args = parseArgs(process.argv.slice(2));
const snaps = readJsonl(SNAPSHOT_PATH);
const ordered = pickSnapshots(snaps, args.mode);
if (ordered.length < args.minTrain + 3) {
  console.log("Not enough snapshots for unsupervised policy backtest.");
  process.exit(0);
}

const maxDate = ordered.map((s) => s.date).sort().at(-1);
const maxDateObj = parseIsoDate(maxDate);
const cutoff = new Date(maxDateObj.getTime() - (args.days - 1) * 24 * 60 * 60 * 1000);
const filtered = ordered.filter((s) => {
  const d = parseIsoDate(s.date);
  return d && d >= cutoff;
});

const categoryKeys = filtered[0]?.categories?.map((c) => c.key) || [];
const X = filtered.map((s) => buildStateVector(s, categoryKeys));

const rows = [];
for (let t = args.minTrain; t < filtered.length - 1; t += 1) {
  const snap = filtered[t];
  const next = filtered[t + 1];
  const baselineTargets = (snap.focusTargets || snap.targets || []).slice(0, args.topN);
  if (baselineTargets.length === 0) continue;

  const unsup = recommendTargetsUnsupervised({
    t,
    X,
    snapshots: filtered,
    categoryKeys,
    topN: args.topN,
    minPts: args.minPts,
    epsPercentile: args.epsPercentile,
    knnK: args.knnK,
  });

  const baselineGain = realizedGainForTargets(snap, next, baselineTargets);
  const unsupGain = realizedGainForTargets(snap, next, unsup.targets);

  rows.push({
    date: snap.date,
    nextDate: next.date,
    baselineTargets,
    unsupTargets: unsup.targets,
    baselineGain,
    unsupGain,
    delta: unsupGain - baselineGain,
    method: unsup.method,
    support: unsup.support,
    eps: unsup.eps,
    clusters: unsup.clusters,
  });
}

if (rows.length === 0) {
  console.log("No backtest rows available after filtering.");
  process.exit(0);
}

const meanBaseline = mean(rows.map((r) => r.baselineGain));
const meanUnsup = mean(rows.map((r) => r.unsupGain));
const wins = rows.filter((r) => r.unsupGain > r.baselineGain).length;
const ties = rows.filter((r) => r.unsupGain === r.baselineGain).length;
const losses = rows.length - wins - ties;

const summary = {
  generatedAt: new Date().toISOString(),
  window: {
    from: filtered[0]?.date,
    to: filtered.at(-1)?.date,
    days: args.days,
    mode: args.mode,
  },
  params: {
    topN: args.topN,
    minTrain: args.minTrain,
    minPts: args.minPts,
    epsPercentile: args.epsPercentile,
    knnK: args.knnK,
  },
  sampleSize: rows.length,
  metrics: {
    baselineMeanRealizedGain: meanBaseline,
    unsupervisedMeanRealizedGain: meanUnsup,
    meanDelta: meanUnsup - meanBaseline,
    wins,
    ties,
    losses,
    winRate: wins / rows.length,
  },
  rows,
};

if (args.write) {
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));

  const md = [];
  md.push("# Unsupervised Policy Backtest");
  md.push("");
  md.push(`Window: ${summary.window.from} to ${summary.window.to} (${summary.window.mode})`);
  md.push(`Samples: ${summary.sampleSize}`);
  md.push("");
  md.push("## Mean Realized Next-Day Category Point Gain");
  md.push(`- Baseline (existing focus targets): ${meanBaseline.toFixed(3)}`);
  md.push(`- Unsupervised (DBSCAN + kNN fallback): ${meanUnsup.toFixed(3)}`);
  md.push(`- Delta (unsupervised - baseline): ${(meanUnsup - meanBaseline).toFixed(3)}`);
  md.push(`- Win/Tie/Loss: ${wins}/${ties}/${losses}`);
  md.push("");
  md.push("## Recent Rows");
  rows.slice(-10).forEach((r) => {
    md.push(`- ${r.date} -> ${r.nextDate}: baseline ${r.baselineGain.toFixed(2)} vs unsup ${r.unsupGain.toFixed(2)} (${r.method}, support=${r.support})`);
  });
  fs.writeFileSync(OUT_MD, md.join("\n") + "\n");
}

console.log("Unsupervised policy backtest complete.");
console.log(`Samples: ${rows.length}`);
console.log(`Baseline mean gain: ${meanBaseline.toFixed(3)}`);
console.log(`Unsupervised mean gain: ${meanUnsup.toFixed(3)}`);
console.log(`Delta: ${(meanUnsup - meanBaseline).toFixed(3)}`);
console.log(`Win/Tie/Loss: ${wins}/${ties}/${losses}`);
console.log(`Report JSON: ${OUT_JSON}`);
console.log(`Report Markdown: ${OUT_MD}`);
