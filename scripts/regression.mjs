import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "logs", "snapshots.jsonl");

function parseArgs(argv) {
  const args = { days: 14, mode: "daily" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--days") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.days = Math.floor(v);
      i += 1;
    } else if (a === "--all-runs") {
      args.mode = "all";
    } else if (a === "--daily") {
      args.mode = "daily";
    }
  }
  return args;
}

function parseIsoDate(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return new Date(Date.UTC(y, mo - 1, d));
}

function daysBetweenUtc(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "object" && "value" in value) return toNumber(value.value);
  return null;
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

function isBenchSelectedPositions(selected) {
  if (!Array.isArray(selected)) return false;
  return selected.some((pos) => ["BN", "BE"].includes(String(pos).toUpperCase()));
}

function inferActions(prevSnapshot, currentSnapshot) {
  if (!prevSnapshot?.roster || !currentSnapshot?.roster) return null;
  if (!Array.isArray(prevSnapshot.roster) || !Array.isArray(currentSnapshot.roster)) {
    return null;
  }
  if (prevSnapshot.roster.length === 0 || currentSnapshot.roster.length === 0) {
    return null;
  }
  const prevMap = new Map(prevSnapshot.roster.map((p) => [p.playerKey, p]));
  const currMap = new Map(currentSnapshot.roster.map((p) => [p.playerKey, p]));
  const adds = [];
  const drops = [];
  const starts = [];
  const benches = [];

  currMap.forEach((curr, key) => {
    if (!prevMap.has(key)) {
      adds.push(curr.name);
    } else {
      const prev = prevMap.get(key);
      const prevBench = isBenchSelectedPositions(prev.selected);
      const currBench = isBenchSelectedPositions(curr.selected);
      if (prevBench && !currBench) starts.push(curr.name);
      else if (!prevBench && currBench) benches.push(curr.name);
    }
  });
  prevMap.forEach((prev, key) => {
    if (!currMap.has(key)) drops.push(prev.name);
  });

  if (adds.length === 0 && drops.length === 0 && starts.length === 0 && benches.length === 0) {
    return null;
  }
  return { adds, drops, starts, benches };
}

function sumPoints(snapshot) {
  if (!snapshot?.categories) return 0;
  return snapshot.categories.reduce((sum, c) => sum + (toNumber(c.points) ?? 0), 0);
}

function sumFocusPoints(snapshot) {
  const keys = snapshot?.focusTargets || snapshot?.targets || [];
  if (!Array.isArray(keys) || keys.length === 0) return 0;
  const by = new Map((snapshot.categories || []).map((c) => [c.key, c]));
  return keys.reduce((sum, k) => sum + (toNumber(by.get(k)?.points) ?? 0), 0);
}

function getCategoryValue(snapshot, key) {
  const c = (snapshot?.categories || []).find((x) => x.key === key);
  return toNumber(c?.value);
}

function pickSnapshots(snaps, mode) {
  if (mode === "all") return snaps.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const byDate = new Map();
  snaps.forEach((s) => {
    if (!s?.date || !s?.timestamp) return;
    const prev = byDate.get(s.date);
    if (!prev || String(s.timestamp) > String(prev.timestamp)) byDate.set(s.date, s);
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function invertMatrix(a) {
  const n = a.length;
  const aug = a.map((row, i) => {
    const out = row.slice();
    for (let j = 0; j < n; j += 1) out.push(i === j ? 1 : 0);
    return out;
  });
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col; r < n; r += 1) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
    }
    if (Math.abs(aug[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = aug[col];
      aug[col] = aug[pivot];
      aug[pivot] = tmp;
    }
    const div = aug[col][col];
    for (let c = 0; c < 2 * n; c += 1) aug[col][c] /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = aug[r][col];
      for (let c = 0; c < 2 * n; c += 1) aug[r][c] -= factor * aug[col][c];
    }
  }
  return aug.map((row) => row.slice(n));
}

function matMul(a, b) {
  const r = a.length;
  const k = a[0].length;
  const c = b[0].length;
  const out = Array.from({ length: r }, () => Array.from({ length: c }, () => 0));
  for (let i = 0; i < r; i += 1) {
    for (let j = 0; j < c; j += 1) {
      let sum = 0;
      for (let t = 0; t < k; t += 1) sum += a[i][t] * b[t][j];
      out[i][j] = sum;
    }
  }
  return out;
}

function transpose(a) {
  const r = a.length;
  const c = a[0].length;
  const out = Array.from({ length: c }, () => Array.from({ length: r }, () => 0));
  for (let i = 0; i < r; i += 1) {
    for (let j = 0; j < c; j += 1) out[j][i] = a[i][j];
  }
  return out;
}

function ols(X, y) {
  // X: n x p, y: n
  const n = X.length;
  const p = X[0].length;
  const yMat = y.map((v) => [v]);
  const Xt = transpose(X);
  const XtX = matMul(Xt, X);
  const inv = invertMatrix(XtX);
  if (!inv) return null;
  const XtY = matMul(Xt, yMat);
  const beta = matMul(inv, XtY).map((row) => row[0]);

  const yHat = X.map((row) => row.reduce((s, v, i) => s + v * beta[i], 0));
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  const ssTot = y.reduce((s, v) => s + Math.pow(v - yMean, 2), 0);
  const ssRes = y.reduce((s, v, i) => s + Math.pow(v - yHat[i], 2), 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { beta, r2, n, p };
}

function corr(x, y) {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const ax = x[i] - mx;
    const ay = y[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  const den = Math.sqrt(dx * dy) || 1;
  return num / den;
}

const args = parseArgs(process.argv.slice(2));
const snaps = readJsonl(SNAPSHOT_PATH);
if (snaps.length < 3) {
  console.log("Not enough snapshots to analyze.");
  process.exit(0);
}

const ordered = pickSnapshots(snaps, args.mode);
const maxDate = ordered.map((s) => s.date).sort().at(-1);
const maxDateObj = parseIsoDate(maxDate);
const cutoff = new Date(maxDateObj.getTime() - (args.days - 1) * 24 * 60 * 60 * 1000);
const filtered = ordered.filter((s) => {
  const d = parseIsoDate(s.date);
  return d && daysBetweenUtc(cutoff, d) >= 0;
});

const rows = [];
for (let i = 1; i < filtered.length; i += 1) {
  const a = filtered[i - 1];
  const b = filtered[i];
  const aD = parseIsoDate(a.date);
  const bD = parseIsoDate(b.date);
  if (!aD || !bD) continue;
  const gapDays = daysBetweenUtc(aD, bD);
  if (gapDays <= 0) continue;

  const prevRank = toNumber(a.overallRank);
  const currRank = toNumber(b.overallRank);
  const yRank = prevRank !== null && currRank !== null ? prevRank - currRank : 0;
  const yTotal = sumPoints(b) - sumPoints(a);
  const yFocus = sumFocusPoints(b) - sumFocusPoints(a);

  const inferred = inferActions(a, b);
  const recStarts = Array.isArray(a.actions?.start) ? a.actions.start : [];
  const usedStarts = inferred?.starts
    ? recStarts.filter((n) => inferred.starts.includes(n)).length
    : 0;

  const recAdds =
    (a.actions?.addBatting?.length || 0) +
    (a.actions?.addPitching?.length || 0) +
    (a.actions?.add?.length || 0);
  const recDrops = a.actions?.drop?.length || 0;

  const actAdds = inferred?.adds?.length || 0;
  const actDrops = inferred?.drops?.length || 0;

  const sv = getCategoryValue(a, "SV");
  const savesEmergency = sv !== null && sv <= 1 ? 1 : 0;
  const hasSvTarget = (a.targets || []).includes("SV") ? 1 : 0;

  rows.push({
    dateA: a.date,
    dateB: b.date,
    gapDays,
    yRank,
    yTotal,
    yFocus,
    yRankPerDay: yRank / gapDays,
    yTotalPerDay: yTotal / gapDays,
    yFocusPerDay: yFocus / gapDays,
    recStarts: recStarts.length,
    usedStarts,
    recAdds,
    recDrops,
    actAdds,
    actDrops,
    savesEmergency,
    hasSvTarget,
  });
}

console.log(`Window: ${filtered[0].date} -> ${filtered.at(-1).date} (${args.days} days, mode=${args.mode})`);
console.log(`Pairs: ${rows.length}`);
if (rows.length < 5) {
  console.log("Not enough day-to-day pairs for meaningful regression (need ~5+).");
  process.exit(0);
}

const yTotal = rows.map((r) => r.yTotalPerDay);
const yRank = rows.map((r) => r.yRankPerDay);
const yFocus = rows.map((r) => r.yFocusPerDay);
const xUsedStarts = rows.map((r) => r.usedStarts);
const xActAdds = rows.map((r) => r.actAdds);
const xActDrops = rows.map((r) => r.actDrops);
const xSavesEmergency = rows.map((r) => r.savesEmergency);
const xGapDays = rows.map((r) => r.gapDays);

console.log("");
console.log("Correlations (Pearson r):");
console.log(`- usedStarts vs deltaTotalPoints: ${corr(xUsedStarts, yTotal).toFixed(2)}`);
console.log(`- actAdds vs deltaTotalPoints: ${corr(xActAdds, yTotal).toFixed(2)}`);
console.log(`- actDrops vs deltaTotalPoints: ${corr(xActDrops, yTotal).toFixed(2)}`);
console.log(`- savesEmergency vs deltaTotalPoints: ${corr(xSavesEmergency, yTotal).toFixed(2)}`);
console.log(`- usedStarts vs deltaRank: ${corr(xUsedStarts, yRank).toFixed(2)}`);
console.log(`- gapDays vs deltaTotalPoints: ${corr(xGapDays, yTotal).toFixed(2)}`);

function printModel(name, model, yLabel, featureNames) {
  if (!model) {
    console.log(`${name}: could not fit (singular matrix).`);
    return;
  }
  const beta = model.beta;
  console.log("");
  console.log(`${name} (y=${yLabel})`);
  console.log(`- n=${model.n}, r2=${model.r2.toFixed(2)}`);
  beta.forEach((b, i) => {
    const label = featureNames[i] || `x${i}`;
    console.log(`- ${label}: ${b.toFixed(3)}`);
  });
}

function fitBest(y, yLabel) {
  const candidates = [
    { name: "OLS", features: ["intercept", "usedStarts"], cols: (r) => [1, r.usedStarts] },
    { name: "OLS", features: ["intercept", "actAdds"], cols: (r) => [1, r.actAdds] },
    { name: "OLS", features: ["intercept", "usedStarts", "actAdds"], cols: (r) => [1, r.usedStarts, r.actAdds] },
    { name: "OLS", features: ["intercept", "usedStarts", "actAdds", "gapDays"], cols: (r) => [1, r.usedStarts, r.actAdds, r.gapDays] },
    { name: "OLS", features: ["intercept", "usedStarts", "gapDays"], cols: (r) => [1, r.usedStarts, r.gapDays] },
  ];
  let best = null;
  let bestMeta = null;
  for (const c of candidates) {
    const X = rows.map(c.cols);
    const model = ols(X, y);
    if (!model) continue;
    if (!best || model.r2 > best.r2) {
      best = model;
      bestMeta = c;
    }
  }
  if (!best) {
    console.log("");
    console.log(`No non-singular OLS fit found for ${yLabel}.`);
    return;
  }
  printModel(bestMeta.name, best, yLabel, bestMeta.features);
}

fitBest(yTotal, "deltaTotalPointsPerDay");
fitBest(yRank, "deltaRankPerDay");
fitBest(yFocus, "deltaFocusPointsPerDay");
