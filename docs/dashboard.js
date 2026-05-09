(() => {
  let state = window.__DASHBOARD_DATA__ || null;
  const DATA_URL = "./dashboard-data.json";
  const REFRESH_MS = 60 * 1000;
  const palette = ["#0ea5e9", "#22c55e", "#f97316", "#a855f7", "#ef4444", "#14b8a6", "#64748b", "#f59e0b"];

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function finite(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function svgLineChart(options) {
    const title = options.title;
    const xLabels = options.xLabels || [];
    const series = options.series || [];
    const yReverse = !!options.yReverse;
    const width = 980;
    const height = 220;
    const padding = { l: 48, r: 18, t: 28, b: 34 };
    const innerW = width - padding.l - padding.r;
    const innerH = height - padding.t - padding.b;
    const allY = [];
    series.forEach((s) => (s.y || []).forEach((v) => {
      const n = finite(v);
      if (n !== null) allY.push(n);
    }));
    const yMin = allY.length ? Math.min.apply(null, allY) : 0;
    const yMax = allY.length ? Math.max.apply(null, allY) : 1;
    const yPad = yMin === yMax ? 1 : (yMax - yMin) * 0.08;
    const min = yMin - yPad;
    const max = yMax + yPad;
    const xCount = Math.max(1, xLabels.length - 1);
    const xPos = (i) => padding.l + (innerW * i) / xCount;
    const yPos = (v) => {
      const t = (v - min) / (max - min || 1);
      return padding.t + innerH * (yReverse ? t : 1 - t);
    };
    let grid = "";
    for (let i = 0; i <= 4; i += 1) {
      const t = i / 4;
      const val = min + (max - min) * (yReverse ? t : 1 - t);
      const y = padding.t + innerH * t;
      grid += '<g><line x1="' + padding.l + '" x2="' + (width - padding.r) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="#e5e7eb" /><text x="' + (padding.l - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#6b7280">' + val.toFixed(2) + "</text></g>";
    }
    const xTickEvery = Math.max(1, Math.ceil(xLabels.length / 10));
    let xTicks = "";
    xLabels.forEach((lbl, i) => {
      if (i % xTickEvery !== 0 && i !== xLabels.length - 1) return;
      const x = xPos(i).toFixed(1);
      xTicks += '<g><line x1="' + x + '" x2="' + x + '" y1="' + (height - padding.b) + '" y2="' + (height - padding.b + 4) + '" stroke="#9ca3af" /><text x="' + x + '" y="' + (height - 10) + '" text-anchor="middle" font-size="11" fill="#6b7280">' + escapeHtml(String(lbl).slice(5)) + "</text></g>";
    });
    const legend = series.map((s, idx) => '<g transform="translate(' + (padding.l + idx * 180) + ',' + (padding.t - 12) + ')"><rect width="10" height="10" fill="' + s.color + '" /><text x="16" y="10" font-size="12" fill="#1f2937">' + escapeHtml(s.name) + "</text></g>").join("");
    const paths = series.map((s) => {
      const pts = (s.y || []).map((v, i) => {
        const n = finite(v);
        return n === null ? null : xPos(i).toFixed(1) + "," + yPos(n).toFixed(1);
      }).filter(Boolean);
      return '<path d="M ' + pts.join(" L ") + '" fill="none" stroke="' + s.color + '" stroke-width="2.2" />';
    }).join("");
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '" role="img" aria-label="' + escapeHtml(title) + '">' +
      '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#ffffff" />' +
      '<text x="' + padding.l + '" y="18" font-size="14" fill="#111827" font-weight="600">' + escapeHtml(title) + "</text>" +
      legend + grid +
      '<line x1="' + padding.l + '" x2="' + (width - padding.r) + '" y1="' + (height - padding.b) + '" y2="' + (height - padding.b) + '" stroke="#9ca3af" />' +
      xTicks + paths + "</svg>";
  }

  function linearFit(x, y) {
    if (!x.length) return null;
    const n = x.length;
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
    const ssTot = y.reduce((s, v) => s + Math.pow(v - my, 2), 0);
    const ssRes = y.reduce((s, v, i) => s + Math.pow(v - (intercept + slope * x[i]), 2), 0);
    return { slope, intercept, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
  }

  function svgScatter(options) {
    const x = options.x || [];
    const y = options.y || [];
    const width = 980;
    const height = 260;
    const padding = { l: 52, r: 18, t: 28, b: 40 };
    const innerW = width - padding.l - padding.r;
    const innerH = height - padding.t - padding.b;
    const points = x.map((vx, i) => ({ vx: finite(vx), vy: finite(y[i]) })).filter((p) => p.vx !== null && p.vy !== null);
    const xs = points.map((p) => p.vx);
    const ys = points.map((p) => p.vy);
    const xMin = xs.length ? Math.min.apply(null, xs) : 0;
    const xMax = xs.length ? Math.max.apply(null, xs) : 1;
    const yMin = ys.length ? Math.min.apply(null, ys) : 0;
    const yMax = ys.length ? Math.max.apply(null, ys) : 1;
    const xPad = xMin === xMax ? 1 : (xMax - xMin) * 0.08;
    const yPad = yMin === yMax ? 1 : (yMax - yMin) * 0.08;
    const minX = xMin - xPad;
    const maxX = xMax + xPad;
    const minY = yMin - yPad;
    const maxY = yMax + yPad;
    const xPos = (v) => padding.l + ((v - minX) / (maxX - minX || 1)) * innerW;
    const yPos = (v) => padding.t + (1 - (v - minY) / (maxY - minY || 1)) * innerH;
    let fitLine = "";
    let fitLabel = "fit unavailable";
    const fit = linearFit(xs, ys);
    if (fit) {
      fitLine = '<line x1="' + xPos(minX).toFixed(1) + '" y1="' + yPos(fit.intercept + fit.slope * minX).toFixed(1) + '" x2="' + xPos(maxX).toFixed(1) + '" y2="' + yPos(fit.intercept + fit.slope * maxX).toFixed(1) + '" stroke="#ef4444" stroke-width="2" opacity="0.9" />';
      fitLabel = "slope " + fit.slope.toFixed(2) + ", r2 " + fit.r2.toFixed(2);
    }
    const pts = points.map((p) => '<circle cx="' + xPos(p.vx).toFixed(1) + '" cy="' + yPos(p.vy).toFixed(1) + '" r="4" fill="#2563eb" opacity="0.85" />').join("");
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '" role="img" aria-label="' + escapeHtml(options.title) + '">' +
      '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#ffffff" />' +
      '<text x="' + padding.l + '" y="18" font-size="14" fill="#111827" font-weight="600">' + escapeHtml(options.title) + "</text>" +
      '<text x="' + (width - padding.r) + '" y="18" font-size="12" fill="#6b7280" text-anchor="end">' + escapeHtml(fitLabel) + "</text>" +
      '<line x1="' + padding.l + '" x2="' + (width - padding.r) + '" y1="' + (height - padding.b) + '" y2="' + (height - padding.b) + '" stroke="#9ca3af" />' +
      '<line x1="' + padding.l + '" x2="' + padding.l + '" y1="' + padding.t + '" y2="' + (height - padding.b) + '" stroke="#9ca3af" />' +
      fitLine + pts +
      '<text x="' + (padding.l + innerW / 2).toFixed(1) + '" y="' + (height - 10) + '" font-size="12" fill="#374151" text-anchor="middle">' + escapeHtml(options.xName) + "</text>" +
      '<text x="14" y="' + (padding.t + innerH / 2).toFixed(1) + '" font-size="12" fill="#374151" text-anchor="middle" transform="rotate(-90 14 ' + (padding.t + innerH / 2).toFixed(1) + ')">' + escapeHtml(options.yName) + "</text>" +
      "</svg>";
  }

  function svgClusterBand(data) {
    if (!Array.isArray(data.clusterAssignments)) return "";
    const xLabels = data.dates || [];
    const clusters = data.clusterAssignments || [];
    const width = 980;
    const height = 86;
    const padding = { l: 48, r: 18, t: 28, b: 20 };
    const innerW = width - padding.l - padding.r;
    const xCount = Math.max(1, xLabels.length - 1);
    const xPos = (i) => padding.l + (innerW * i) / xCount;
    let rects = "";
    clusters.forEach((c, i) => {
      const color = palette[(c || 0) % palette.length];
      rects += '<rect x="' + xPos(i).toFixed(1) + '" y="36" width="' + Math.max(1, xPos(i + 1) - xPos(i)).toFixed(1) + '" height="18" fill="' + color + '" opacity="0.85" />';
    });
    const uniq = Array.from(new Set(clusters.filter((c) => c !== null && c !== undefined))).sort((a, b) => a - b);
    const legend = uniq.slice(0, 8).map((c, idx) => '<g transform="translate(' + (padding.l + idx * 110) + ',18)"><rect width="10" height="10" fill="' + palette[c % palette.length] + '" /><text x="16" y="10" font-size="12" fill="#1f2937">C' + c + "</text></g>").join("");
    return '<div class="card"><svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '" role="img" aria-label="Unsupervised Regime Clusters (Best Model)">' +
      '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#ffffff" />' +
      '<text x="' + padding.l + '" y="18" font-size="14" fill="#111827" font-weight="600">Unsupervised Regime Clusters (Best Model)</text>' +
      legend + rects + '</svg><div class="tiny">Clusters are learned from snapshots; use them as a regime tracker, not a guarantee.</div></div>';
  }

  function latestCard(data) {
    const latest = data.latest || {};
    const actions = latest.actions || {};
    const starts = Array.isArray(actions.start) ? actions.start : [];
    const adds = []
      .concat(Array.isArray(actions.addBatting) ? actions.addBatting : [])
      .concat(Array.isArray(actions.addPitching) ? actions.addPitching : [])
      .concat(Array.isArray(actions.add) ? actions.add : []);
    const drops = Array.isArray(actions.drop) ? actions.drop : [];
    const reviews = Array.isArray(latest.protectedInjuryReviews) ? latest.protectedInjuryReviews : [];
    const diagnostics = latest.dropDiagnostics || {};
    let html = '<div class="card"><h2 style="font-size:16px;margin:0 0 8px;">Latest Recommendation</h2>';
    html += '<div class="tiny">Snapshot ' + escapeHtml(latest.date || "unknown") + '</div>';
    html += '<div><span class="pill">Adds: ' + adds.length + '</span><span class="pill">Drops: ' + drops.length + '</span><span class="pill">Starts: ' + starts.length + '</span></div>';
    if (diagnostics.noAddReason) html += '<p class="tiny">No-add reason: ' + escapeHtml(diagnostics.noAddReason) + '</p>';
    if (starts.length) html += '<p><strong>Starts:</strong> ' + starts.map(escapeHtml).join(", ") + '</p>';
    if (reviews.length) {
      html += '<p><strong>Protected IL checks:</strong></p><ul class="list">';
      reviews.forEach((r) => {
        html += '<li>' + escapeHtml(r.name) + ' (' + escapeHtml(r.status || "IL") + '): ' + escapeHtml(r.reviewStatus) + ', drop eligible: ' + escapeHtml(String(!!r.dropEligible)) + '</li>';
      });
      html += '</ul>';
    }
    html += '</div>';
    return html;
  }

  function render(data) {
    if (!data) return;
    state = data;
    const meta = document.getElementById("dashboard-meta");
    const root = document.getElementById("dashboard-root");
    if (meta) {
      meta.innerHTML = 'Built from <code>' + escapeHtml(data.dataSource) + '</code> • Window: ' + escapeHtml(data.windowStart) + ' → ' + escapeHtml(data.windowEnd) + ' • Mode: ' + escapeHtml(data.mode) + ' • Updated: ' + escapeHtml(data.generatedAt) + ' • Auto-refreshing every 60s';
    }
    if (!root) return;
    root.innerHTML =
      '<div class="row"><div class="card">' + svgLineChart({ title: "Total Roto Points (Sum)", xLabels: data.dates, series: [{ name: "Total Points", color: "#111827", y: data.totalPoints }] }) + '</div>' +
      '<div class="card">' + svgLineChart({ title: "Overall Rank (Lower Is Better)", xLabels: data.dates, series: [{ name: "Rank", color: "#16a34a", y: data.ranks }], yReverse: true }) + '</div></div>' +
      svgClusterBand(data) +
      '<div class="row"><div class="card">' + svgLineChart({ title: "Focus Points (Targets + Best Value)", xLabels: data.dates, series: [{ name: "Focus Points", color: "#7c3aed", y: data.focusPoints }] }) + '</div>' +
      '<div class="card">' + svgLineChart({ title: "Saves (SV)", xLabels: data.dates, series: [{ name: "SV", color: "#f59e0b", y: data.saves }] }) + '</div></div>' +
      latestCard(data) +
      '<div class="card">' + svgScatter({ title: "Regression View: Used Starts vs Delta Total Points/Day", xName: "Recommended starts used (inferred)", yName: "Delta total roto points per day", x: (data.scatter || {}).x || [], y: (data.scatter || {}).y || [] }) +
      '<div class="tiny">Note: “used starts” is inferred from roster position changes between snapshots; if you do not change BN/active slots every day, this understates adherence.</div></div>';
  }

  async function poll() {
    try {
      const response = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!response.ok) return;
      const next = await response.json();
      if (!state || next.generatedAt !== state.generatedAt) render(next);
    } catch {
      // Static pages can be viewed from file:// during local checks; fetch may fail there.
    }
  }

  render(state);
  setInterval(poll, REFRESH_MS);
})();