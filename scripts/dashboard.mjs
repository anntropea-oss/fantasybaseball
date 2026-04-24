import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "logs", "snapshots.jsonl");
const OUT_PATH = path.join(ROOT, "logs", "dashboard.html");
const UNSUPERVISED_PATH = path.join(ROOT, "logs", "unsupervised.json");

function parseArgs(argv) {
  const args = { days: 30, mode: "daily", out: OUT_PATH };
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
    } else if (a === "--out") {
      const v = argv[i + 1];
      if (v) args.out = path.isAbsolute(v) ? v : path.join(ROOT, v);
      i += 1;
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
  if (typeof value === "object" && value && "value" in value) return toNumber(value.value);
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

function getCategory(snapshot, key) {
  return (snapshot?.categories || []).find((c) => c.key === key) || null;
}

function isBenchSelectedPositions(selected) {
  if (!Array.isArray(selected)) return false;
  return selected.some((pos) => ["BN", "BE"].includes(String(pos).toUpperCase()));
}

function inferActions(prevSnapshot, currentSnapshot) {
  if (!prevSnapshot?.roster || !currentSnapshot?.roster) return null;
  if (!Array.isArray(prevSnapshot.roster) || !Array.isArray(currentSnapshot.roster)) return null;
  if (prevSnapshot.roster.length === 0 || currentSnapshot.roster.length === 0) return null;

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

function linearFit(x, y) {
  const n = x.length;
  if (n === 0) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (x[i] - mx) * (y[i] - my);
    den += Math.pow(x[i] - mx, 2);
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  const yHat = x.map((v) => intercept + slope * v);
  const ssTot = y.reduce((s, v) => s + Math.pow(v - my, 2), 0);
  const ssRes = y.reduce((s, v, i) => s + Math.pow(v - yHat[i], 2), 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, r2 };
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function svgLineChart({ title, xLabels, series, width = 980, height = 220, yReverse = false }) {
  const padding = { l: 48, r: 18, t: 28, b: 34 };
  const w = width;
  const h = height;
  const innerW = w - padding.l - padding.r;
  const innerH = h - padding.t - padding.b;

  const allY = [];
  series.forEach((s) => {
    s.y.forEach((v) => {
      if (Number.isFinite(v)) allY.push(v);
    });
  });
  const yMin = allY.length ? Math.min(...allY) : 0;
  const yMax = allY.length ? Math.max(...allY) : 1;
  const yPad = yMin === yMax ? 1 : (yMax - yMin) * 0.08;
  const min = yMin - yPad;
  const max = yMax + yPad;

  const xCount = Math.max(1, xLabels.length - 1);
  const xPos = (i) => padding.l + (innerW * i) / xCount;
  const yPos = (v) => {
    const t = (v - min) / (max - min || 1);
    const tt = yReverse ? t : 1 - t;
    return padding.t + innerH * tt;
  };

  const gridLines = 4;
  const grid = [];
  for (let i = 0; i <= gridLines; i += 1) {
    const t = i / gridLines;
    const val = min + (max - min) * (yReverse ? t : 1 - t);
    const y = padding.t + innerH * t;
    grid.push({ y, val });
  }

  const xTickEvery = Math.max(1, Math.ceil(xLabels.length / 10));
  const xTicks = xLabels
    .map((lbl, i) => ({ lbl, i }))
    .filter((t) => t.i % xTickEvery === 0 || t.i === xLabels.length - 1);

  const paths = series
    .map((s) => {
      const pts = s.y
        .map((v, i) => (Number.isFinite(v) ? `${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}` : null))
        .filter(Boolean);
      return `<path d="M ${pts.join(" L ")}" fill="none" stroke="${s.color}" stroke-width="2.2" />`;
    })
    .join("\n");

  const legend = series
    .map(
      (s, idx) =>
        `<g transform="translate(${padding.l + idx * 180},${padding.t - 12})"><rect width="10" height="10" fill="${s.color}" /><text x="16" y="10" font-size="12" fill="#1f2937">${escapeHtml(s.name)}</text></g>`
    )
    .join("");

  const gridSvg = grid
    .map(
      (g) =>
        `<g><line x1="${padding.l}" x2="${w - padding.r}" y1="${g.y.toFixed(1)}" y2="${g.y.toFixed(1)}" stroke="#e5e7eb" /><text x="${padding.l - 8}" y="${(g.y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b7280">${g.val.toFixed(2)}</text></g>`
    )
    .join("\n");

  const xTicksSvg = xTicks
    .map((t) => {
      const x = xPos(t.i).toFixed(1);
      return `<g><line x1="${x}" x2="${x}" y1="${h - padding.b}" y2="${h - padding.b + 4}" stroke="#9ca3af" /><text x="${x}" y="${h - 10}" text-anchor="middle" font-size="11" fill="#6b7280">${escapeHtml(t.lbl.slice(5))}</text></g>`;
    })
    .join("\n");

  return `
<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${escapeHtml(title)}">
  <rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff" />
  <text x="${padding.l}" y="18" font-size="14" fill="#111827" font-weight="600">${escapeHtml(title)}</text>
  ${legend}
  ${gridSvg}
  <line x1="${padding.l}" x2="${w - padding.r}" y1="${h - padding.b}" y2="${h - padding.b}" stroke="#9ca3af" />
  ${xTicksSvg}
  ${paths}
</svg>`.trim();
}

function svgScatter({ title, xName, yName, x, y, width = 980, height = 260 }) {
  const padding = { l: 52, r: 18, t: 28, b: 40 };
  const w = width;
  const h = height;
  const innerW = w - padding.l - padding.r;
  const innerH = h - padding.t - padding.b;

  const xs = x.filter((v) => Number.isFinite(v));
  const ys = y.filter((v) => Number.isFinite(v));
  const xMin = xs.length ? Math.min(...xs) : 0;
  const xMax = xs.length ? Math.max(...xs) : 1;
  const yMin = ys.length ? Math.min(...ys) : 0;
  const yMax = ys.length ? Math.max(...ys) : 1;
  const xPad = xMin === xMax ? 1 : (xMax - xMin) * 0.08;
  const yPad = yMin === yMax ? 1 : (yMax - yMin) * 0.08;
  const minX = xMin - xPad;
  const maxX = xMax + xPad;
  const minY = yMin - yPad;
  const maxY = yMax + yPad;

  const xPos = (v) => padding.l + ((v - minX) / (maxX - minX || 1)) * innerW;
  const yPos = (v) => padding.t + (1 - (v - minY) / (maxY - minY || 1)) * innerH;

  const pts = x
    .map((vx, i) => ({ vx, vy: y[i] }))
    .filter((p) => Number.isFinite(p.vx) && Number.isFinite(p.vy))
    .map((p) => `<circle cx="${xPos(p.vx).toFixed(1)}" cy="${yPos(p.vy).toFixed(1)}" r="4" fill="#2563eb" opacity="0.85" />`)
    .join("\n");

  const fit = linearFit(
    x.filter((v, i) => Number.isFinite(v) && Number.isFinite(y[i])),
    y.filter((v, i) => Number.isFinite(v) && Number.isFinite(x[i]))
  );
  let line = "";
  let fitLabel = "fit unavailable";
  if (fit) {
    const x1 = minX;
    const x2 = maxX;
    const y1 = fit.intercept + fit.slope * x1;
    const y2 = fit.intercept + fit.slope * x2;
    line = `<line x1="${xPos(x1).toFixed(1)}" y1="${yPos(y1).toFixed(1)}" x2="${xPos(x2).toFixed(1)}" y2="${yPos(y2).toFixed(1)}" stroke="#ef4444" stroke-width="2" opacity="0.9" />`;
    fitLabel = `slope ${fit.slope.toFixed(2)}, r2 ${fit.r2.toFixed(2)}`;
  }

  return `
<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${escapeHtml(title)}">
  <rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff" />
  <text x="${padding.l}" y="18" font-size="14" fill="#111827" font-weight="600">${escapeHtml(title)}</text>
  <text x="${w - padding.r}" y="18" font-size="12" fill="#6b7280" text-anchor="end">${escapeHtml(fitLabel)}</text>
  <line x1="${padding.l}" x2="${w - padding.r}" y1="${h - padding.b}" y2="${h - padding.b}" stroke="#9ca3af" />
  <line x1="${padding.l}" x2="${padding.l}" y1="${padding.t}" y2="${h - padding.b}" stroke="#9ca3af" />
  ${line}
  ${pts}
  <text x="${(padding.l + innerW / 2).toFixed(1)}" y="${h - 10}" font-size="12" fill="#374151" text-anchor="middle">${escapeHtml(xName)}</text>
  <text x="14" y="${(padding.t + innerH / 2).toFixed(1)}" font-size="12" fill="#374151" text-anchor="middle" transform="rotate(-90 14 ${(padding.t + innerH / 2).toFixed(1)})">${escapeHtml(yName)}</text>
</svg>`.trim();
}

function svgClusterBand({ title, xLabels, clusters, width = 980, height = 86 }) {
  const padding = { l: 48, r: 18, t: 28, b: 20 };
  const w = width;
  const h = height;
  const innerW = w - padding.l - padding.r;
  const xCount = Math.max(1, xLabels.length - 1);
  const xPos = (i) => padding.l + (innerW * i) / xCount;
  const barH = 18;
  const y = padding.t + 8;
  const palette = ["#0ea5e9", "#22c55e", "#f97316", "#a855f7", "#ef4444", "#14b8a6", "#64748b", "#f59e0b"];
  const rects = clusters
    .map((c, i) => {
      const x1 = xPos(i);
      const x2 = xPos(i + 1);
      const color = palette[(c ?? 0) % palette.length];
      return `<rect x="${x1.toFixed(1)}" y="${y}" width="${Math.max(1, x2 - x1).toFixed(1)}" height="${barH}" fill="${color}" opacity="0.85" />`;
    })
    .join("\n");
  const xTickEvery = Math.max(1, Math.ceil(xLabels.length / 10));
  const xTicks = xLabels
    .map((lbl, i) => ({ lbl, i }))
    .filter((t) => t.i % xTickEvery === 0 || t.i === xLabels.length - 1);
  const xTicksSvg = xTicks
    .map((t) => {
      const x = xPos(t.i).toFixed(1);
      return `<g><line x1="${x}" x2="${x}" y1="${h - padding.b}" y2="${h - padding.b + 4}" stroke="#9ca3af" /><text x="${x}" y="${h - 6}" text-anchor="middle" font-size="11" fill="#6b7280">${escapeHtml(t.lbl.slice(5))}</text></g>`;
    })
    .join("\n");
  const uniq = [...new Set(clusters.filter((c) => c !== null && c !== undefined))].sort((a, b) => a - b);
  const legend = uniq
    .slice(0, 8)
    .map((c, idx) => {
      const color = palette[c % palette.length];
      return `<g transform="translate(${padding.l + idx * 110},${padding.t - 10})"><rect width="10" height="10" fill="${color}" /><text x="16" y="10" font-size="12" fill="#1f2937">C${c}</text></g>`;
    })
    .join("");
  return `
<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${escapeHtml(title)}">
  <rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff" />
  <text x="${padding.l}" y="18" font-size="14" fill="#111827" font-weight="600">${escapeHtml(title)}</text>
  ${legend}
  ${rects}
  <line x1="${padding.l}" x2="${w - padding.r}" y1="${h - padding.b}" y2="${h - padding.b}" stroke="#9ca3af" />
  ${xTicksSvg}
</svg>`.trim();
}

const args = parseArgs(process.argv.slice(2));
const snaps = readJsonl(SNAPSHOT_PATH);
if (snaps.length < 2) {
  console.log("Not enough snapshots to build dashboard.");
  process.exit(0);
}

const ordered = pickSnapshots(snaps, args.mode);
const maxDate = ordered.map((s) => s.date).sort().at(-1);
const maxDateObj = parseIsoDate(maxDate);
const cutoff = new Date(maxDateObj.getTime() - (args.days - 1) * 24 * 60 * 60 * 1000);
const filtered = ordered.filter((s) => {
  const d = parseIsoDate(s.date);
  return d && d >= cutoff;
});

const dates = filtered.map((s) => s.date);
const ranks = filtered.map((s) => toNumber(s.overallRank));
const totalPoints = filtered.map((s) => sumPoints(s));
const focusPoints = filtered.map((s) => sumFocusPoints(s));
const saves = filtered.map((s) => toNumber(getCategory(s, "SV")?.value));

let clusterAssignments = null;
if (fs.existsSync(UNSUPERVISED_PATH)) {
  try {
    const unsup = JSON.parse(fs.readFileSync(UNSUPERVISED_PATH, "utf8"));
    const assigns = unsup?.best?.assignments || [];
    const byDate = new Map(assigns.map((a) => [a.date, a.cluster]));
    clusterAssignments = dates.map((d) => (byDate.has(d) ? byDate.get(d) : null));
  } catch {
    clusterAssignments = null;
  }
}

const pairs = [];
for (let i = 1; i < filtered.length; i += 1) {
  const a = filtered[i - 1];
  const b = filtered[i];
  const aD = parseIsoDate(a.date);
  const bD = parseIsoDate(b.date);
  if (!aD || !bD) continue;
  const gapDays = daysBetweenUtc(aD, bD);
  if (gapDays <= 0) continue;
  const inferred = inferActions(a, b);
  const recStarts = Array.isArray(a.actions?.start) ? a.actions.start : [];
  const usedStarts = inferred?.starts
    ? recStarts.filter((n) => inferred.starts.includes(n)).length
    : 0;
  pairs.push({
    date: b.date,
    gapDays,
    usedStarts,
    actAdds: inferred?.adds?.length || 0,
    deltaTotalPerDay: (sumPoints(b) - sumPoints(a)) / gapDays,
  });
}

const scatterX = pairs.map((p) => p.usedStarts);
const scatterY = pairs.map((p) => p.deltaTotalPerDay);

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fantasy Baseball Dashboard</title>
  <style>
    :root { --bg: #f8fafc; --ink: #0f172a; --muted: #475569; --card: #ffffff; --border: #e2e8f0; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; background: var(--bg); color: var(--ink); }
    .wrap { max-width: 1080px; margin: 20px auto 48px; padding: 0 16px; }
    h1 { font-size: 20px; margin: 0 0 6px; }
    .meta { color: var(--muted); font-size: 13px; margin-bottom: 14px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
    .row { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 940px) { .row { grid-template-columns: 1fr 1fr; } }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 6px; }
    .tiny { font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Fantasy Baseball Tracker</h1>
    <div class="meta">Built from <code>logs/snapshots.jsonl</code> • Window: ${escapeHtml(dates[0])} → ${escapeHtml(dates.at(-1))} • Mode: ${escapeHtml(args.mode)} • Updated: ${escapeHtml(new Date().toISOString())}</div>

    <div class="row">
      <div class="card">
        ${svgLineChart({
          title: "Total Roto Points (Sum)",
          xLabels: dates,
          series: [{ name: "Total Points", color: "#111827", y: totalPoints }],
        })}
      </div>
      <div class="card">
        ${svgLineChart({
          title: "Overall Rank (Lower Is Better)",
          xLabels: dates,
          series: [{ name: "Rank", color: "#16a34a", y: ranks }],
          yReverse: true,
        })}
      </div>
    </div>

    ${
      clusterAssignments
        ? `<div class="card">${svgClusterBand({
            title: "Unsupervised Regime Clusters (Best Model)",
            xLabels: dates,
            clusters: clusterAssignments,
          })}<div class="tiny">Clusters are learned from the last N days of snapshots; they group similar team states. Use them as a “regime” tracker, not a guarantee.</div></div>`
        : ""
    }

    <div class="row">
      <div class="card">
        ${svgLineChart({
          title: "Focus Points (Targets + Best Value)",
          xLabels: dates,
          series: [{ name: "Focus Points", color: "#7c3aed", y: focusPoints }],
        })}
      </div>
      <div class="card">
        ${svgLineChart({
          title: "Saves (SV)",
          xLabels: dates,
          series: [{ name: "SV", color: "#f59e0b", y: saves }],
        })}
      </div>
    </div>

    <div class="card">
      ${svgScatter({
        title: "Regression View: Used Starts vs Delta Total Points/Day",
        xName: "Recommended starts used (inferred)",
        yName: "Delta total roto points per day",
        x: scatterX,
        y: scatterY,
      })}
      <div class="tiny">Note: “used starts” is inferred from roster position changes between snapshots; if you don’t change BN/active slots every day, this understates adherence.</div>
    </div>
  </div>
</body>
</html>`;

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, html);
console.log(`Wrote ${args.out}`);
