import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "logs", "snapshots.jsonl");

function parseArgs(argv) {
  const args = {
    days: 365,
    mode: "daily",
    topN: 3,
    minTrain: 10,
    pcaK: 4,
    trees: 80,
    maxDepth: 3,
    knnK: 7,
    ridgeAlpha: 1.2,
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
      if (Number.isFinite(v) && v >= 5) args.minTrain = Math.floor(v);
      i += 1;
    } else if (a === "--pca-k") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.pcaK = Math.floor(v);
      i += 1;
    } else if (a === "--trees") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.trees = Math.floor(v);
      i += 1;
    } else if (a === "--max-depth") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.maxDepth = Math.floor(v);
      i += 1;
    } else if (a === "--knn-k") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.knnK = Math.floor(v);
      i += 1;
    } else if (a === "--ridge-alpha") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v >= 0) args.ridgeAlpha = v;
      i += 1;
    }
  }
  return args;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseIsoDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function pickSnapshots(snapshots, mode) {
  const ordered = snapshots
    .slice()
    .sort((a, b) => String(a.timestamp || a.date).localeCompare(String(b.timestamp || b.date)));
  if (mode === "all") return ordered;
  const byDate = new Map();
  ordered.forEach((s) => {
    if (!s?.date) return;
    byDate.set(s.date, s);
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

function categoryMap(snapshot) {
  const out = new Map();
  (snapshot?.categories || []).forEach((cat) => {
    if (!cat?.key) return;
    out.set(cat.key, {
      points: toNumber(cat.points) ?? 0,
      rank: toNumber(cat.rank) ?? 0,
      value: toNumber(cat.value) ?? 0,
    });
  });
  return out;
}

function sumPoints(snapshot) {
  let sum = 0;
  categoryMap(snapshot).forEach((cat) => {
    sum += cat.points;
  });
  return sum;
}

function rosterCounts(snapshot) {
  const out = { active: 0, bench: 0, il: 0, pitcher: 0, hitter: 0 };
  const roster = Array.isArray(snapshot?.roster) ? snapshot.roster : [];
  roster.forEach((player) => {
    const slot = String(player.selectedPrimary || "").toUpperCase();
    const positions = Array.isArray(player.positions) ? player.positions.map((p) => String(p)) : [];
    if (slot === "BN" || slot === "BE") out.bench += 1;
    else if (slot === "IL") out.il += 1;
    else out.active += 1;
    if (positions.some((p) => ["SP", "RP", "P"].includes(p))) out.pitcher += 1;
    else out.hitter += 1;
  });
  return out;
}

function actionCounts(snapshot) {
  const a = snapshot?.actions || {};
  return {
    adds: (a.add?.length || 0) + (a.addBatting?.length || 0) + (a.addPitching?.length || 0),
    drops: a.drop?.length || 0,
    starts: a.start?.length || 0,
  };
}

function categoryDelta(a, b, key) {
  return (categoryMap(b).get(key)?.points ?? 0) - (categoryMap(a).get(key)?.points ?? 0);
}

function previousDelta(snapshots, index, key, lag = 1) {
  const from = index - lag;
  const to = index - lag + 1;
  if (from < 0 || to < 0) return 0;
  return categoryDelta(snapshots[from], snapshots[to], key);
}

function trailingMeanDelta(snapshots, index, key, window) {
  const vals = [];
  for (let i = Math.max(0, index - window); i < index; i += 1) {
    vals.push(categoryDelta(snapshots[i], snapshots[i + 1], key));
  }
  return mean(vals);
}

function gapFeatures(snapshot, key) {
  const gap = snapshot?.categoryNextGaps?.[key] || {};
  return [
    toNumber(gap.deltaToNext) ?? 0,
    toNumber(gap.pointsGainToNext) ?? 0,
    String(gap.status || "") === "available" ? 1 : 0,
  ];
}

function buildRowFeatures(snapshots, index, key, categoryKeys) {
  const s = snapshots[index];
  const cats = categoryMap(s);
  const c = cats.get(key) || { points: 0, rank: 0, value: 0 };
  const season = toNumber(s.seasonProgress) ?? 0;
  const ip = toNumber(s.ipValue) ?? 0;
  const ipCap = toNumber(s.ipCap) ?? 0;
  const gp = toNumber(s.gpValue) ?? 0;
  const gpCap = toNumber(s.gpCap) ?? 0;
  const ipPace = season > 0 && ipCap > 0 ? ip / (ipCap * season) : 0;
  const gpPace = season > 0 && gpCap > 0 ? gp / (gpCap * season) : 0;
  const roster = rosterCounts(s);
  const actions = actionCounts(s);
  const focusTargets = new Set([...(s.focusTargets || []), ...(s.targets || [])]);
  const bestValueTargets = new Set(s.bestValueTargets || []);

  const row = [
    toNumber(s.overallRank) ?? 0,
    sumPoints(s),
    season,
    ipPace,
    gpPace,
    c.points,
    c.rank,
    c.value,
    focusTargets.has(key) ? 1 : 0,
    bestValueTargets.has(key) ? 1 : 0,
    previousDelta(snapshots, index, key, 1),
    previousDelta(snapshots, index, key, 2),
    trailingMeanDelta(snapshots, index, key, 3),
    trailingMeanDelta(snapshots, index, key, 7),
    actions.adds,
    actions.drops,
    actions.starts,
    roster.active,
    roster.bench,
    roster.il,
    roster.pitcher,
    roster.hitter,
    ...gapFeatures(s, key),
  ];

  categoryKeys.forEach((k) => {
    const other = cats.get(k) || { points: 0, rank: 0 };
    row.push(other.points, other.rank);
  });
  return row;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function dist2(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2;
  return sum;
}

function fitScaler(X) {
  const d = X[0]?.length || 0;
  const means = Array(d).fill(0);
  const stds = Array(d).fill(1);
  for (let j = 0; j < d; j += 1) means[j] = mean(X.map((row) => row[j]));
  for (let j = 0; j < d; j += 1) {
    stds[j] = Math.sqrt(mean(X.map((row) => (row[j] - means[j]) ** 2))) || 1;
  }
  return { means, stds };
}

function applyScaler(X, scaler) {
  return X.map((row) => row.map((value, j) => (value - scaler.means[j]) / scaler.stds[j]));
}

function ridgeTrain(X, y, alpha, { lr = 0.025, iters = 900 } = {}) {
  const d = X[0].length;
  const w = Array(d).fill(0);
  let b = 0;
  for (let iter = 0; iter < iters; iter += 1) {
    const gw = Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i += 1) {
      const err = dot(w, X[i]) + b - y[i];
      gb += err;
      for (let j = 0; j < d; j += 1) gw[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j += 1) w[j] -= lr * (gw[j] / X.length + alpha * w[j]);
    b -= lr * (gb / X.length);
  }
  return { w, b };
}

function pcaFit(X, k) {
  const n = X.length;
  const d = X[0].length;
  const cov = Array.from({ length: d }, () => Array(d).fill(0));
  for (const row of X) {
    for (let i = 0; i < d; i += 1) {
      for (let j = i; j < d; j += 1) cov[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < d; i += 1) {
    for (let j = i; j < d; j += 1) {
      cov[i][j] /= Math.max(1, n - 1);
      cov[j][i] = cov[i][j];
    }
  }

  const comps = [];
  const matrix = cov.map((row) => row.slice());
  const count = Math.min(k, d);
  for (let c = 0; c < count; c += 1) {
    let v = Array.from({ length: d }, (_, i) => (i + c + 1) / d - 0.5);
    for (let iter = 0; iter < 80; iter += 1) {
      const mv = matrix.map((row) => dot(row, v));
      const norm = Math.sqrt(dot(mv, mv)) || 1;
      v = mv.map((value) => value / norm);
    }
    const lambda = dot(v, matrix.map((row) => dot(row, v)));
    comps.push(v.slice());
    for (let i = 0; i < d; i += 1) {
      for (let j = 0; j < d; j += 1) matrix[i][j] -= lambda * v[i] * v[j];
    }
  }
  return { comps };
}

function pcaProject(X, pca) {
  return X.map((row) => pca.comps.map((comp) => dot(row, comp)));
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

function trainTree(X, y, { maxDepth, minLeaf = 4, rng }) {
  const featureCount = X[0].length;
  const mtry = Math.max(1, Math.floor(Math.sqrt(featureCount)));

  function mse(indices) {
    const vals = indices.map((i) => y[i]);
    const m = mean(vals);
    return vals.reduce((sum, value) => sum + (value - m) ** 2, 0);
  }

  function sampleFeatures() {
    const features = Array.from({ length: featureCount }, (_, i) => i);
    for (let i = features.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [features[i], features[j]] = [features[j], features[i]];
    }
    return features.slice(0, mtry);
  }

  function build(indices, depth) {
    const pred = mean(indices.map((i) => y[i]));
    if (depth >= maxDepth || indices.length < minLeaf * 2) return { leaf: true, pred };
    let best = null;
    for (const feature of sampleFeatures()) {
      const sorted = indices.map((i) => X[i][feature]).sort((a, b) => a - b);
      const thresholds = [0.25, 0.5, 0.75].map((q) => sorted[Math.floor(q * (sorted.length - 1))]);
      for (const threshold of thresholds) {
        const left = indices.filter((i) => X[i][feature] <= threshold);
        const right = indices.filter((i) => X[i][feature] > threshold);
        if (left.length < minLeaf || right.length < minLeaf) continue;
        const loss = mse(left) + mse(right);
        if (!best || loss < best.loss) best = { feature, threshold, left, right, loss };
      }
    }
    if (!best) return { leaf: true, pred };
    return {
      leaf: false,
      feature: best.feature,
      threshold: best.threshold,
      left: build(best.left, depth + 1),
      right: build(best.right, depth + 1),
    };
  }

  return build(Array.from({ length: X.length }, (_, i) => i), 0);
}

function predictTree(tree, row) {
  let node = tree;
  while (!node.leaf) node = row[node.feature] <= node.threshold ? node.left : node.right;
  return node.pred;
}

function forestTrain(X, y, { trees, maxDepth, seed }) {
  const rng = mulberry32(seed);
  const models = [];
  for (let t = 0; t < trees; t += 1) {
    const bx = [];
    const by = [];
    for (let i = 0; i < X.length; i += 1) {
      const idx = Math.floor(rng() * X.length);
      bx.push(X[idx]);
      by.push(y[idx]);
    }
    models.push(trainTree(bx, by, { maxDepth, rng }));
  }
  return models;
}

function forestPredict(models, row) {
  return mean(models.map((model) => predictTree(model, row)));
}

function topTargets(scoreMap, n) {
  return [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key]) => key);
}

function scoreTargets(snapshot, nextSnapshot, targets) {
  return targets.reduce((sum, key) => sum + categoryDelta(snapshot, nextSnapshot, key), 0);
}

function oracleTargets(snapshot, nextSnapshot, categoryKeys, topN) {
  return categoryKeys
    .map((key) => [key, categoryDelta(snapshot, nextSnapshot, key)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key]) => key);
}

function rankAverageScore(scoreMaps, categoryKeys) {
  const out = new Map(categoryKeys.map((key) => [key, 0]));
  scoreMaps.forEach((scores) => {
    [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([key], index) => {
        out.set(key, (out.get(key) || 0) + (categoryKeys.length - index));
      });
  });
  return out;
}

function evaluate(rows) {
  const gains = rows.map((r) => r.gain);
  const oracleGains = rows.map((r) => r.oracleGain);
  const regrets = rows.map((r) => r.oracleGain - r.gain);
  const positiveOracleRows = rows.filter((r) => r.oracleGain > 0);
  const pickCount = rows.reduce((sum, r) => sum + r.targets.length, 0);
  const positivePicks = rows.reduce(
    (sum, r) => sum + r.targets.filter((key) => r.categoryDeltas[key] > 0).length,
    0
  );
  return {
    n: rows.length,
    meanGain: mean(gains),
    medianGain: median(gains),
    meanOracleGain: mean(oracleGains),
    meanRegret: mean(regrets),
    captureRate:
      positiveOracleRows.length > 0
        ? mean(positiveOracleRows.map((r) => r.gain / r.oracleGain))
        : 0,
    positiveDayRate: rows.filter((r) => r.gain > 0).length / rows.length,
    nonNegativeDayRate: rows.filter((r) => r.gain >= 0).length / rows.length,
    pickHitRate: pickCount > 0 ? positivePicks / pickCount : 0,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildTrainingData(snapshots, categoryKeys, trainEndIndex) {
  const X = [];
  const yByKey = new Map(categoryKeys.map((key) => [key, []]));
  for (let i = 0; i < trainEndIndex; i += 1) {
    categoryKeys.forEach((key) => {
      X.push(buildRowFeatures(snapshots, i, key, categoryKeys));
      yByKey.get(key).push(categoryDelta(snapshots[i], snapshots[i + 1], key));
    });
  }

  const byKeyX = new Map(categoryKeys.map((key) => [key, []]));
  for (let i = 0; i < trainEndIndex; i += 1) {
    categoryKeys.forEach((key) => {
      byKeyX.get(key).push(buildRowFeatures(snapshots, i, key, categoryKeys));
    });
  }
  return { byKeyX, yByKey };
}

function predictKnn(trainX, trainY, row, k) {
  const dists = trainX.map((x, i) => ({ i, d: dist2(x, row) })).sort((a, b) => a.d - b.d);
  return mean(dists.slice(0, Math.min(k, dists.length)).map(({ i }) => trainY[i]));
}

function runBenchmark(snapshots, args) {
  const categoryKeys = snapshots[0]?.categories?.map((cat) => cat.key) || [];
  const methods = new Map([
    ["baseline", []],
    ["oracle", []],
    ["weakest", []],
    ["momentum", []],
    ["knn", []],
    ["ridge", []],
    ["pca_ridge", []],
    ["forest", []],
    ["ensemble", []],
  ]);

  for (let t = args.minTrain; t < snapshots.length - 1; t += 1) {
    const snapshot = snapshots[t];
    const nextSnapshot = snapshots[t + 1];
    const deltas = Object.fromEntries(categoryKeys.map((key) => [key, categoryDelta(snapshot, nextSnapshot, key)]));
    const oracle = oracleTargets(snapshot, nextSnapshot, categoryKeys, args.topN);
    const oracleGain = scoreTargets(snapshot, nextSnapshot, oracle);
    const baseline = (snapshot.focusTargets || snapshot.targets || []).slice(0, args.topN);
    const weakest = categoryKeys
      .map((key) => [key, categoryMap(snapshot).get(key)?.points ?? 0])
      .sort((a, b) => a[1] - b[1])
      .slice(0, args.topN)
      .map(([key]) => key);
    const momentumScores = new Map(
      categoryKeys.map((key) => [key, trailingMeanDelta(snapshots, t, key, Math.min(7, t))])
    );

    const { byKeyX, yByKey } = buildTrainingData(snapshots, categoryKeys, t);
    const allTrainX = [...byKeyX.values()].flat();
    const scaler = fitScaler(allTrainX);
    const ridgeScores = new Map();
    const pcaScores = new Map();
    const forestScores = new Map();
    const knnScores = new Map();

    categoryKeys.forEach((key) => {
      const trainXRaw = byKeyX.get(key);
      const trainY = yByKey.get(key);
      const trainX = applyScaler(trainXRaw, scaler);
      const row = applyScaler([buildRowFeatures(snapshots, t, key, categoryKeys)], scaler)[0];

      knnScores.set(key, predictKnn(trainX, trainY, row, args.knnK));

      const ridge = ridgeTrain(trainX, trainY, args.ridgeAlpha);
      ridgeScores.set(key, dot(ridge.w, row) + ridge.b);

      const pca = pcaFit(trainX, args.pcaK);
      const px = pcaProject(trainX, pca);
      const prow = pcaProject([row], pca)[0];
      const pr = ridgeTrain(px, trainY, args.ridgeAlpha * 0.75);
      pcaScores.set(key, dot(pr.w, prow) + pr.b);

      const forest = forestTrain(trainX, trainY, {
        trees: args.trees,
        maxDepth: args.maxDepth,
        seed: 1000 + t,
      });
      forestScores.set(key, forestPredict(forest, row));
    });

    const ensembleScores = rankAverageScore([knnScores, ridgeScores, pcaScores, forestScores], categoryKeys);
    const targetSets = {
      baseline,
      oracle,
      weakest,
      momentum: topTargets(momentumScores, args.topN),
      knn: topTargets(knnScores, args.topN),
      ridge: topTargets(ridgeScores, args.topN),
      pca_ridge: topTargets(pcaScores, args.topN),
      forest: topTargets(forestScores, args.topN),
      ensemble: topTargets(ensembleScores, args.topN),
    };

    Object.entries(targetSets).forEach(([method, targets]) => {
      if (!targets.length) return;
      methods.get(method).push({
        date: snapshot.date,
        nextDate: nextSnapshot.date,
        targets,
        gain: scoreTargets(snapshot, nextSnapshot, targets),
        oracleTargets: oracle,
        oracleGain,
        categoryDeltas: deltas,
      });
    });
  }

  return {
    categoryKeys,
    methods: Object.fromEntries([...methods.entries()].map(([method, rows]) => [method, evaluate(rows)])),
    rows: Object.fromEntries(methods),
  };
}

const args = parseArgs(process.argv.slice(2));
const outJson = path.join(
  ROOT,
  "logs",
  `model-benchmark-deep-${args.mode}-top${args.topN}-train${args.minTrain}.json`
);
const raw = readJsonl(SNAPSHOT_PATH);
const selected = pickSnapshots(raw, args.mode);
if (selected.length < args.minTrain + 2) {
  console.log("Not enough snapshots for benchmark.");
  process.exit(0);
}

const maxDate = selected.map((s) => s.date).sort().at(-1);
const cutoff = new Date(parseIsoDate(maxDate).getTime() - (args.days - 1) * 24 * 60 * 60 * 1000);
const filtered = selected.filter((s) => {
  const d = parseIsoDate(s.date);
  return d && d >= cutoff;
});

const result = runBenchmark(filtered, args);
const baseline = result.methods.baseline;
const summary = {
  generatedAt: new Date().toISOString(),
  window: {
    mode: args.mode,
    from: filtered[0]?.date,
    to: filtered.at(-1)?.date,
    snapshots: filtered.length,
    rawSnapshots: raw.length,
    uniqueDates: new Set(raw.map((s) => s.date)).size,
  },
  params: args,
  categoryKeys: result.categoryKeys,
  methods: Object.fromEntries(
    Object.entries(result.methods).map(([method, metrics]) => [
      method,
      {
        ...metrics,
        deltaMeanGainVsBaseline: metrics.meanGain - baseline.meanGain,
        deltaRegretVsBaseline: baseline.meanRegret - metrics.meanRegret,
      },
    ])
  ),
  rows: result.rows,
};

fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(summary, null, 2));

console.log("Deep model benchmark complete.");
console.log(`Mode: ${summary.window.mode}, snapshots: ${summary.window.snapshots}, window: ${summary.window.from} -> ${summary.window.to}`);
Object.entries(summary.methods)
  .sort((a, b) => b[1].meanGain - a[1].meanGain)
  .forEach(([method, m]) => {
    console.log(
      `${method}: meanGain=${m.meanGain.toFixed(3)} regret=${m.meanRegret.toFixed(3)} capture=${(m.captureRate * 100).toFixed(1)}% hit=${(m.pickHitRate * 100).toFixed(1)}% delta=${m.deltaMeanGainVsBaseline.toFixed(3)}`
    );
  });
console.log(`Report: ${outJson}`);
