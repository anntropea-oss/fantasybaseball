import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { execFileSync, spawnSync } from "child_process";
import { loadTokens, saveTokens, yahooRequest, refreshTokens, isTokenExpired } from "./yahoo-api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, "config.json");
const CONFIG_EXAMPLE_PATH = path.join(__dirname, "config.example.json");
const LEAGUE_SETTINGS_PATH =
  "/Users/atropea/coding/fantasy baseball/fantasy/league-settings.json";
const DEBUG_DIR = path.join(__dirname, "debug");
const LOG_DIR = path.join(__dirname, "logs");
const SNAPSHOT_LOG = path.join(LOG_DIR, "snapshots.jsonl");
const ACTION_LOG = path.join(LOG_DIR, "actions.jsonl");
const DAILY_LOG = path.join(LOG_DIR, "daily-log.md");
const LEARNING_PATH = path.join(LOG_DIR, "learning.json");
const DB_PATH = path.join(LOG_DIR, "fantasy.db");
const MODEL_BENCHMARK_HISTORY_LOG = path.join(LOG_DIR, "model-benchmark-history.jsonl");
const MODEL_BENCHMARK_DAILY_REPORT = path.join(
  LOG_DIR,
  "model-benchmark-deep-daily-top3-train10.json"
);
const MODEL_BENCHMARK_ALL_REPORT = path.join(
  LOG_DIR,
  "model-benchmark-deep-all-top3-train20.json"
);
const DROP_RANK_FLOOR = 120;
const DROP_RANK_FLOOR_SECONDARY = 80;
const ADD_RANK_IMPROVEMENT = 30;
const ADD_STAT_SCORE_IMPROVEMENT = 0.5;
const EFFECTIVENESS_DELAY_DAYS = 2;
const FREE_AGENT_COUNT = 50;
const FREE_AGENT_COUNT_POSITION = 200;
const FREE_AGENT_COUNT_SAVES = 200;
const PROTECT_TOP_YAHOO_RANK = 30;
const PROTECTED_INJURY_REVIEW_MAX_AGE_DAYS = 7;
const HISTORY_SEASONS = 5;
const HITTER_STABILIZER_AB = 200;
const PITCHER_STABILIZER_IP = 30;
const MAX_HISTORY_KEYS = 80;
const MAX_ARCHETYPE_KEYS = 120;

const AUTH_AUTHORIZE_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const AUTH_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const FANTASY_API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";
const MLB_STATS_API_BASE = "https://statsapi.mlb.com/api/v1";

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  if (String(message).includes("SQLite")) {
    return;
  }
  return emitWarning(warning, ...args);
};

function loadConfig() {
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } else if (fs.existsSync(CONFIG_EXAMPLE_PATH)) {
    fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
    throw new Error(
      `Missing config.json. I created it from config.example.json. Please fill in your keys in ${CONFIG_PATH}.`
    );
  } else {
    throw new Error(`Missing config.json at ${CONFIG_PATH}.`);
  }

  if (process.env.YAHOO_CONSUMER_KEY) {
    config.consumerKey = process.env.YAHOO_CONSUMER_KEY;
  }
  if (process.env.YAHOO_CONSUMER_SECRET) {
    config.consumerSecret = process.env.YAHOO_CONSUMER_SECRET;
  }

  if (!config.consumerKey || !config.consumerSecret) {
    throw new Error(
      "consumerKey/consumerSecret missing. Set them in config.json or via YAHOO_CONSUMER_KEY/YAHOO_CONSUMER_SECRET."
    );
  }

  return config;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function loadLeagueSettingsFile() {
  if (!fs.existsSync(LEAGUE_SETTINGS_PATH)) return null;
  return JSON.parse(fs.readFileSync(LEAGUE_SETTINGS_PATH, "utf8"));
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptYesNo(question) {
  const answer = await prompt(question);
  return answer.toLowerCase().startsWith("y");
}

async function promptList(question) {
  const answer = await prompt(question);
  return answer
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function shouldPromptForLog() {
  if (process.env.FANTASY_LOG_PROMPT === "1") return true;
  return false;
}

function shouldGenerateDashboard() {
  if (process.argv.includes("--no-dashboard")) return false;
  if (process.env.FANTASY_DASHBOARD === "0") return false;
  return true;
}

function generateDashboardTo(outPath = null) {
  if (!shouldGenerateDashboard()) return;
  try {
    try {
      const unsupPath = path.join(__dirname, "scripts", "unsupervised.mjs");
      execFileSync(process.execPath, [unsupPath, "--days", "30", "--daily"], {
        stdio: "ignore",
      });
    } catch {
      // best-effort
    }
    const scriptPath = path.join(__dirname, "scripts", "dashboard.mjs");
    const args = [scriptPath, "--days", "30", "--daily"];
    if (outPath) args.push("--out", outPath);
    execFileSync(process.execPath, args, { stdio: "ignore" });
  } catch {
    // Best-effort: dashboard should never break recommend.
  }
}

function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function benchmarkMethodRows(report) {
  return Object.entries(report?.methods || {})
    .filter(([method]) => !["baseline", "oracle"].includes(method))
    .map(([method, metrics]) => ({
      method,
      meanGain: toNumber(metrics.meanGain) ?? 0,
      meanRankAwareGain: toNumber(metrics.meanRankAwareGain) ?? 0,
      meanRegret: toNumber(metrics.meanRegret) ?? 0,
      meanRankAwareRegret: toNumber(metrics.meanRankAwareRegret) ?? 0,
      deltaMeanGainVsBaseline: toNumber(metrics.deltaMeanGainVsBaseline) ?? 0,
      deltaRankAwareGainVsBaseline: toNumber(metrics.deltaRankAwareGainVsBaseline) ?? 0,
      deltaRegretVsBaseline: toNumber(metrics.deltaRegretVsBaseline) ?? 0,
      deltaRankAwareRegretVsBaseline: toNumber(metrics.deltaRankAwareRegretVsBaseline) ?? 0,
      n: toNumber(metrics.n) ?? 0,
    }));
}

function benchmarkBestChallenger(report) {
  const rows = benchmarkMethodRows(report).sort(
    (a, b) => b.deltaRankAwareGainVsBaseline - a.deltaRankAwareGainVsBaseline
  );
  return rows[0] || null;
}

function benchmarkQualifiesAsChampion(dailyReport, allReport, method) {
  if (!dailyReport || !allReport || !method) return false;
  const daily = dailyReport.methods?.[method] || null;
  const allRuns = allReport.methods?.[method] || null;
  if (!daily || !allRuns) return false;
  const dailyDelta = toNumber(daily.deltaMeanGainVsBaseline) ?? -Infinity;
  const allDelta = toNumber(allRuns.deltaMeanGainVsBaseline) ?? -Infinity;
  const dailyRankAwareDelta =
    toNumber(daily.deltaRankAwareGainVsBaseline) ?? -Infinity;
  const allRankAwareDelta =
    toNumber(allRuns.deltaRankAwareGainVsBaseline) ?? -Infinity;
  const dailyN = toNumber(daily.n) ?? 0;
  const dailyRegretDelta =
    toNumber(daily.deltaRankAwareRegretVsBaseline) ??
    toNumber(daily.deltaRegretVsBaseline) ??
    -Infinity;
  const allRegretDelta =
    toNumber(allRuns.deltaRankAwareRegretVsBaseline) ??
    toNumber(allRuns.deltaRegretVsBaseline) ??
    -Infinity;
  return (
    dailyRankAwareDelta > 0.15 &&
    allRankAwareDelta > 0.05 &&
    dailyDelta >= -0.05 &&
    allDelta >= -0.05 &&
    dailyN >= 20 &&
    dailyRegretDelta >= 0 &&
    allRegretDelta >= 0
  );
}

function benchmarkFreshness() {
  const snapshots = readJsonl(SNAPSHOT_LOG);
  if (snapshots.length === 0) {
    return { fresh: true, snapshotCount: 0, latestDate: null };
  }
  const latest = snapshots
    .slice()
    .sort((a, b) => String(a.timestamp || a.id || a.date).localeCompare(String(b.timestamp || b.id || b.date)))
    .at(-1);
  const latestDate = latest?.date || null;
  const snapshotCount = snapshots.length;
  const reportFresh = (report) => {
    if (!report) return false;
    const reportRaw = toNumber(report.window?.rawSnapshots) ?? 0;
    const reportTo = report.window?.to || null;
    if (reportRaw < snapshotCount) return false;
    if (latestDate && reportTo && String(reportTo) < String(latestDate)) return false;
    if (latestDate && !reportTo) return false;
    return true;
  };
  const daily = readJsonFileSafe(MODEL_BENCHMARK_DAILY_REPORT);
  const allRuns = readJsonFileSafe(MODEL_BENCHMARK_ALL_REPORT);
  return {
    fresh: reportFresh(daily) && reportFresh(allRuns),
    snapshotCount,
    latestDate,
    dailyRawSnapshots: toNumber(daily?.window?.rawSnapshots) ?? 0,
    allRawSnapshots: toNumber(allRuns?.window?.rawSnapshots) ?? 0,
  };
}

function benchmarkPromotionCandidate() {
  const daily = readJsonFileSafe(MODEL_BENCHMARK_DAILY_REPORT);
  const allRuns = readJsonFileSafe(MODEL_BENCHMARK_ALL_REPORT);
  if (!benchmarkFreshness().fresh) return null;
  const best = benchmarkBestChallenger(daily);
  if (!best || !benchmarkQualifiesAsChampion(daily, allRuns, best.method)) {
    return null;
  }
  return best.method;
}

function formatSigned(value, digits = 3) {
  const n = toNumber(value) ?? 0;
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

function benchmarkModelStatusLines() {
  const daily = readJsonFileSafe(MODEL_BENCHMARK_DAILY_REPORT);
  const allRuns = readJsonFileSafe(MODEL_BENCHMARK_ALL_REPORT);
  if (!daily && !allRuns) {
    return ["Champion: current heuristic (benchmark not run yet; use `node cli.js benchmark`)."];
  }

  const dailyBaseline = daily?.methods?.baseline || null;
  const dailyOracle = daily?.methods?.oracle || null;
  const allBaseline = allRuns?.methods?.baseline || null;
  const best = benchmarkBestChallenger(daily);
  const freshness = benchmarkFreshness();
  const promoted = best
    ? freshness.fresh && benchmarkQualifiesAsChampion(daily, allRuns, best.method)
    : false;
  const lines = [];

  lines.push(
    promoted
      ? `Champion: ${best.method} is active for target selection.`
      : freshness.fresh
        ? "Champion: current heuristic remains production default."
        : `Champion: current heuristic remains production default (benchmark stale vs ${freshness.snapshotCount} snapshots; run \`node cli.js benchmark\`).`
  );
  if (dailyBaseline) {
    lines.push(
      `Daily top-3 baseline rank-aware gain ${formatSigned(
        dailyBaseline.meanRankAwareGain ?? dailyBaseline.meanGain
      )}; raw ${formatSigned(dailyBaseline.meanGain)}; regret ${
        (
          toNumber(dailyBaseline.meanRankAwareRegret) ??
          toNumber(dailyBaseline.meanRegret) ??
          0
        ).toFixed(3)
      } vs oracle.`
    );
  }
  if (dailyOracle && dailyBaseline) {
    const rankAwareOracleGap =
      (toNumber(dailyOracle.meanRankAwareGain) ?? toNumber(dailyOracle.meanGain) ?? 0) -
      (toNumber(dailyBaseline.meanRankAwareGain) ?? toNumber(dailyBaseline.meanGain) ?? 0);
    const rawOracleGap =
      (toNumber(dailyOracle.meanGain) ?? 0) - (toNumber(dailyBaseline.meanGain) ?? 0);
    lines.push(
      `Rank-aware oracle gap: ${formatSigned(rankAwareOracleGap)} weighted points per evaluated snapshot; raw gap ${formatSigned(rawOracleGap)}.`
    );
  }
  if (best) {
    const allDelta = allRuns?.methods?.[best.method]?.deltaRankAwareGainVsBaseline;
    const allText = allDelta !== undefined ? `, all-runs ${formatSigned(allDelta)}` : "";
    lines.push(
      `Closest challenger: ${best.method} rank-aware daily ${formatSigned(
        best.deltaRankAwareGainVsBaseline
      )}${allText} vs baseline.`
    );
  }
  if (allBaseline) {
    lines.push(
      `All-runs sensitivity baseline rank-aware gain ${formatSigned(
        allBaseline.meanRankAwareGain ?? allBaseline.meanGain
      )}.`
    );
  }
  return lines;
}

function printModelStatus() {
  console.log(cYellow("Model check:"));
  benchmarkModelStatusLines().forEach((line) => console.log(fmtBullet(line)));
  console.log("");
}

function shouldOpenDashboard() {
  if (process.argv.includes("--open-dashboard")) return true;
  if (process.argv.includes("--no-open-dashboard")) return false;
  return process.env.FANTASY_DASHBOARD_OPEN === "1";
}

function openDashboardFile(filePath) {
  try {
    // macOS
    const mac = spawnSync("open", [filePath], { stdio: "ignore" });
    if (mac.status === 0) return true;
  } catch {
    // ignore
  }
  try {
    // Linux
    const linux = spawnSync("xdg-open", [filePath], { stdio: "ignore" });
    if (linux.status === 0) return true;
  } catch {
    // ignore
  }
  return false;
}

async function dashboard() {
  const publish = process.argv.includes("--publish");
  const filePath = publish
    ? path.join(__dirname, "docs", "index.html")
    : path.join(__dirname, "logs", "dashboard.html");

  generateDashboardTo(filePath);
  console.log(`Dashboard: ${filePath}`);
  if (shouldOpenDashboard()) {
    const ok = openDashboardFile(filePath);
    if (!ok) {
      console.log("Could not auto-open dashboard. Try:");
      console.log(`open ${filePath}`);
    }
  } else {
    console.log("Open it with:");
    console.log(`open ${filePath}`);
  }
}

function runBenchmarkCommand(args, label) {
  const scriptPath = path.join(__dirname, "scripts", "model-benchmark-deep.mjs");
  console.log(cYellow(`Running ${label} benchmark...`));
  execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: __dirname,
    stdio: "inherit",
  });
}

function appendBenchmarkHistoryEntry() {
  const daily = readJsonFileSafe(MODEL_BENCHMARK_DAILY_REPORT);
  const allRuns = readJsonFileSafe(MODEL_BENCHMARK_ALL_REPORT);
  if (!daily && !allRuns) return;
  const dailyBest = benchmarkBestChallenger(daily);
  const allBest = benchmarkBestChallenger(allRuns);
  appendJsonl(MODEL_BENCHMARK_HISTORY_LOG, {
    id: new Date().toISOString(),
    daily: daily
      ? {
          report: MODEL_BENCHMARK_DAILY_REPORT,
          baseline: daily.methods?.baseline || null,
          oracle: daily.methods?.oracle || null,
          bestChallenger: dailyBest,
        }
      : null,
    allRuns: allRuns
      ? {
          report: MODEL_BENCHMARK_ALL_REPORT,
          baseline: allRuns.methods?.baseline || null,
          oracle: allRuns.methods?.oracle || null,
          bestChallenger: allBest,
        }
      : null,
    promotionCandidate:
      dailyBest && benchmarkQualifiesAsChampion(daily, allRuns, dailyBest.method)
        ? dailyBest.method
        : null,
  });
}

async function benchmark() {
  const dailyOnly = process.argv.includes("--daily-only");
  const allRunsOnly = process.argv.includes("--all-runs-only");
  if (!allRunsOnly) {
    runBenchmarkCommand(
      [
        "--days",
        "365",
        "--daily",
        "--top",
        "3",
        "--min-train",
        "10",
        "--knn-k",
        "7",
        "--pca-k",
        "4",
        "--trees",
        "80",
        "--max-depth",
        "3",
      ],
      "daily champion/challenger"
    );
  }
  if (!dailyOnly) {
    runBenchmarkCommand(
      [
        "--days",
        "365",
        "--all-runs",
        "--top",
        "3",
        "--min-train",
        "20",
        "--knn-k",
        "9",
        "--pca-k",
        "5",
        "--trees",
        "80",
        "--max-depth",
        "3",
      ],
      "all-runs sensitivity"
    );
  }
  appendBenchmarkHistoryEntry();
  console.log("");
  printModelStatus();
  console.log(`Benchmark history: ${MODEL_BENCHMARK_HISTORY_LOG}`);
}

async function refreshBenchmarkIfStaleForRecommend() {
  if (process.env.FANTASY_AUTO_BENCHMARK === "0") return false;
  if (process.argv.includes("--no-benchmark-refresh")) return false;
  const freshness = benchmarkFreshness();
  if (freshness.fresh) return false;
  console.log(
    cYellow(
      `Benchmark stale or missing vs ${freshness.snapshotCount} snapshots; refreshing before recommend...`
    )
  );
  await benchmark();
  console.log("");
  return true;
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendJsonl(filePath, payload) {
  ensureLogDir();
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function uniqueLimit(items, max) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  return lines
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

let dbPromise = null;

function jsonText(value) {
  return JSON.stringify(value ?? null);
}

async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const { DatabaseSync } = await import("node:sqlite");
    ensureLogDir();
    const db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        date TEXT,
        timestamp TEXT,
        league_key TEXT,
        team_key TEXT,
        league_name TEXT,
        team_name TEXT,
        overall_rank REAL,
        season_progress REAL,
        gp_value REAL,
        gp_cap REAL,
        ip_value REAL,
        ip_cap REAL,
        points_to_next_delta REAL,
        points_to_next_team_key TEXT,
        points_to_next_team_name TEXT,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS category_standings (
        snapshot_id TEXT NOT NULL,
        category_key TEXT NOT NULL,
        stat_id TEXT,
        name TEXT,
        value REAL,
        points REAL,
        rank REAL,
        rank_source TEXT,
        PRIMARY KEY (snapshot_id, category_key),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS category_next_gaps (
        snapshot_id TEXT NOT NULL,
        category_key TEXT NOT NULL,
        direction TEXT,
        my_value REAL,
        my_points REAL,
        next_team_key TEXT,
        next_team_name TEXT,
        next_value REAL,
        next_points REAL,
        delta_to_next REAL,
        points_gain_to_next REAL,
        status TEXT,
        PRIMARY KEY (snapshot_id, category_key),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS league_category_standings (
        snapshot_id TEXT NOT NULL,
        category_key TEXT NOT NULL,
        stat_id TEXT,
        team_key TEXT NOT NULL,
        team_name TEXT,
        value REAL,
        points REAL,
        rank REAL,
        total_points REAL,
        PRIMARY KEY (snapshot_id, category_key, team_key),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS lineup_slots (
        snapshot_id TEXT NOT NULL,
        player_key TEXT NOT NULL,
        player_name TEXT,
        selected_primary TEXT,
        selected_json TEXT,
        PRIMARY KEY (snapshot_id, player_key),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS recommendations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        player_name TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        raw_json TEXT,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS inferred_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT NOT NULL,
        source_snapshot_id TEXT,
        action_type TEXT NOT NULL,
        player_name TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        raw_json TEXT,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS action_logs (
        id TEXT PRIMARY KEY,
        date TEXT,
        snapshot_id TEXT,
        adds_json TEXT,
        drops_json TEXT,
        starts_json TEXT,
        benches_json TEXT,
        notes TEXT,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS historical_player_pools (
        season INTEGER NOT NULL,
        game_key TEXT NOT NULL,
        fetched_at TEXT,
        player_count INTEGER,
        page_count INTEGER,
        raw_json TEXT,
        PRIMARY KEY (season, game_key)
      );

      CREATE TABLE IF NOT EXISTS historical_players (
        season INTEGER NOT NULL,
        game_key TEXT NOT NULL,
        player_key TEXT NOT NULL,
        player_id TEXT,
        name TEXT,
        positions_json TEXT,
        status TEXT,
        yahoo_rank REAL,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (season, player_key)
      );

      CREATE TABLE IF NOT EXISTS historical_player_stats (
        season INTEGER NOT NULL,
        game_key TEXT NOT NULL,
        player_key TEXT NOT NULL,
        stat_id TEXT NOT NULL,
        value REAL,
        raw_value TEXT,
        PRIMARY KEY (season, player_key, stat_id)
      );

      CREATE TABLE IF NOT EXISTS historical_leagues (
        season INTEGER NOT NULL,
        game_key TEXT NOT NULL,
        league_key TEXT NOT NULL,
        team_key TEXT,
        fetched_at TEXT,
        raw_json TEXT,
        PRIMARY KEY (season, league_key)
      );

      CREATE TABLE IF NOT EXISTS historical_team_category_stats (
        season INTEGER NOT NULL,
        league_key TEXT NOT NULL,
        team_key TEXT NOT NULL,
        team_name TEXT,
        stat_id TEXT NOT NULL,
        value REAL,
        points REAL,
        PRIMARY KEY (season, league_key, team_key, stat_id)
      );
    `);
    return db;
  })();
  return dbPromise;
}

function runStmt(db, sql, params = []) {
  db.prepare(sql).run(...params);
}

async function writeSnapshotToDb(snapshot) {
  if (!snapshot?.id) return;
  const db = await getDb();
  const ptn = snapshot.pointsToNextTeam || {};
  db.exec("BEGIN;");
  try {
    runStmt(
      db,
      `INSERT OR REPLACE INTO snapshots (
        id, date, timestamp, league_key, team_key, league_name, team_name,
        overall_rank, season_progress, gp_value, gp_cap, ip_value, ip_cap,
        points_to_next_delta, points_to_next_team_key, points_to_next_team_name,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        snapshot.date || null,
        snapshot.timestamp || null,
        snapshot.leagueKey || null,
        snapshot.teamKey || null,
        snapshot.leagueName || null,
        snapshot.teamName || null,
        toNumber(snapshot.overallRank),
        toNumber(snapshot.seasonProgress),
        toNumber(snapshot.gpValue),
        toNumber(snapshot.gpCap),
        toNumber(snapshot.ipValue),
        toNumber(snapshot.ipCap),
        toNumber(ptn.delta),
        ptn.nextTeamKey || null,
        ptn.nextTeamName || null,
        jsonText(snapshot),
      ]
    );

    [
      "category_standings",
      "category_next_gaps",
      "league_category_standings",
      "lineup_slots",
      "recommendations",
      "inferred_actions",
    ].forEach((table) => {
      runStmt(db, `DELETE FROM ${table} WHERE snapshot_id = ?`, [snapshot.id]);
    });

    (snapshot.categories || []).forEach((cat) => {
      runStmt(
        db,
        `INSERT INTO category_standings (
          snapshot_id, category_key, stat_id, name, value, points, rank, rank_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.id,
          cat.key || null,
          cat.statId || null,
          cat.name || null,
          toNumber(cat.value),
          toNumber(cat.points),
          toNumber(cat.rank),
          cat.rankSource || null,
        ]
      );
    });

    Object.entries(snapshot.categoryNextGaps || {}).forEach(([key, gap]) => {
      runStmt(
        db,
        `INSERT INTO category_next_gaps (
          snapshot_id, category_key, direction, my_value, my_points,
          next_team_key, next_team_name, next_value, next_points,
          delta_to_next, points_gain_to_next, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.id,
          key,
          gap.direction || null,
          toNumber(gap.myValue),
          toNumber(gap.myPoints),
          gap.nextTeamKey || null,
          gap.nextTeamName || null,
          toNumber(gap.nextValue),
          toNumber(gap.nextPoints),
          toNumber(gap.deltaToNext),
          toNumber(gap.pointsGainToNext),
          gap.status || null,
        ]
      );
    });

    (snapshot.leagueStandings?.categories || []).forEach((cat) => {
      (Array.isArray(cat.teams) ? cat.teams : []).forEach((team) => {
        if (!team.teamKey) return;
        runStmt(
          db,
          `INSERT INTO league_category_standings (
            snapshot_id, category_key, stat_id, team_key, team_name,
            value, points, rank, total_points
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshot.id,
            cat.key || null,
            cat.statId || null,
            team.teamKey,
            team.teamName || null,
            toNumber(team.value),
            toNumber(team.points),
            toNumber(team.rank),
            toNumber(team.totalPoints),
          ]
        );
      });
    });

    (snapshot.roster || []).forEach((player) => {
      if (!player.playerKey) return;
      runStmt(
        db,
        `INSERT INTO lineup_slots (
          snapshot_id, player_key, player_name, selected_primary, selected_json
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          snapshot.id,
          player.playerKey,
          player.name || null,
          player.selectedPrimary || null,
          jsonText(player.selected || []),
        ]
      );
    });

    Object.entries(snapshot.actions || {}).forEach(([type, names]) => {
      const details = Array.isArray(snapshot.actionDetails?.[type])
        ? snapshot.actionDetails[type]
        : [];
      (Array.isArray(names) ? names : []).forEach((name, idx) => {
        runStmt(
          db,
          `INSERT INTO recommendations (
            snapshot_id, action_type, player_name, ordinal, raw_json
          ) VALUES (?, ?, ?, ?, ?)`,
          [snapshot.id, type, name, idx, jsonText(details[idx] || { type, name })]
        );
      });
    });

    const inferred = snapshot.inferredActionsFromPrev || null;
    if (inferred) {
      ["adds", "drops", "starts", "benches"].forEach((type) => {
        (Array.isArray(inferred[type]) ? inferred[type] : []).forEach((name, idx) => {
          runStmt(
            db,
            `INSERT INTO inferred_actions (
              snapshot_id, source_snapshot_id, action_type, player_name, ordinal, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              snapshot.id,
              inferred.snapshotId || null,
              type,
              name,
              idx,
              jsonText({ type, name, source: inferred.source || null }),
            ]
          );
        });
      });
    }

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

async function writeActionLogToDb(actionEntry) {
  if (!actionEntry?.id) return;
  const db = await getDb();
  runStmt(
    db,
    `INSERT OR REPLACE INTO action_logs (
      id, date, snapshot_id, adds_json, drops_json, starts_json,
      benches_json, notes, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actionEntry.id,
      actionEntry.date || null,
      actionEntry.snapshotId || null,
      jsonText(actionEntry.adds || []),
      jsonText(actionEntry.drops || []),
      jsonText(actionEntry.starts || []),
      jsonText(actionEntry.benches || []),
      actionEntry.notes || "",
      jsonText(actionEntry),
    ]
  );
}

async function backfillDb() {
  const snapshots = readJsonl(SNAPSHOT_LOG);
  const actions = readJsonl(ACTION_LOG);
  for (const snapshot of snapshots) {
    await writeSnapshotToDb(snapshot);
  }
  for (const action of actions) {
    await writeActionLogToDb(action);
  }
  console.log(`Backfilled SQLite: ${snapshots.length} snapshots, ${actions.length} action logs`);
  console.log(`Database: ${DB_PATH}`);
}

async function latestSnapshotFromDb() {
  try {
    const db = await getDb();
    const row = db
      .prepare("SELECT raw_json FROM snapshots ORDER BY timestamp DESC LIMIT 1")
      .get();
    if (row?.raw_json) return JSON.parse(row.raw_json);
  } catch {
    // Fall back to JSONL below.
  }
  const snapshots = readJsonl(SNAPSHOT_LOG);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

function loadLearning() {
  if (!fs.existsSync(LEARNING_PATH)) {
    return { categoryBoost: {}, lastEvaluatedActionId: null, lastEvaluatedSnapshotId: null };
  }
  try {
    const data = JSON.parse(fs.readFileSync(LEARNING_PATH, "utf8"));
    return {
      categoryBoost: data.categoryBoost || {},
      lastEvaluatedActionId: data.lastEvaluatedActionId || null,
      lastEvaluatedSnapshotId: data.lastEvaluatedSnapshotId || null,
    };
  } catch {
    return { categoryBoost: {}, lastEvaluatedActionId: null, lastEvaluatedSnapshotId: null };
  }
}

function saveLearning(learning) {
  ensureLogDir();
  fs.writeFileSync(LEARNING_PATH, JSON.stringify(learning, null, 2));
}

function appendDailyLog(lines) {
  ensureLogDir();
  const content = lines.join("\n") + "\n";
  fs.appendFileSync(DAILY_LOG, content);
}

function todayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function getTopLimit(defaultValue = 3) {
  const raw = getArgValue("--top");
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.floor(parsed);
}

function getPositionFilter() {
  const raw = getArgValue("--position") ?? getArgValue("--pos");
  if (!raw) return null;
  const upper = raw.toString().trim().toUpperCase();
  if (upper === "CATCHER") return "C";
  return upper;
}

function isVerboseEnabled() {
  return process.argv.includes("--verbose") || process.env.FANTASY_VERBOSE === "1";
}

function supportsColorOutput() {
  if (process.env.NO_COLOR) return false;
  if (!process.stdout || !process.stdout.isTTY) return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

function ansi(code, text) {
  if (!supportsColorOutput()) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

function cGreen(text) {
  return ansi("32", text);
}

function cYellow(text) {
  // "Brownish" in many terminals; matches the screenshot vibe.
  return ansi("33", text);
}

function cBlue(text) {
  return ansi("34", text);
}

function fmtBullet(text) {
  return `${cBlue("-")} ${cGreen(text)}`;
}

function fmtLine(text) {
  return cGreen(text);
}

function formatMaybeNumber(value, digits = 2) {
  const n = toNumber(value);
  if (n === null) return "n/a";
  return Number.isInteger(n) ? `${n}` : n.toFixed(digits);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getListArg(flag) {
  const args = process.argv;
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      const val = args[i + 1];
      if (val && !val.startsWith("--")) {
        val
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .forEach((item) => values.push(item));
        i += 1;
      }
    }
  }
  return values;
}

function isDebugEnabled() {
  return process.argv.includes("--debug") || process.env.YAHOO_DEBUG === "1";
}

function debugLog(message, data = null) {
  if (!isDebugEnabled()) return;
  if (data) {
    console.log(`[debug] ${message}`, data);
  } else {
    console.log(`[debug] ${message}`);
  }
}

function isDebugJsonEnabled() {
  return (
    process.argv.includes("--debug-json") ||
    process.env.YAHOO_DEBUG_JSON === "1"
  );
}

function writeDebugJson(name, data) {
  if (!isDebugJsonEnabled()) return;
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const filePath = path.join(
    DEBUG_DIR,
    `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`[debug-json] wrote ${filePath}`);
}

function cleanupDebugFiles() {
  if (!fs.existsSync(DEBUG_DIR)) {
    console.log("No debug directory found.");
    return;
  }
  const files = fs.readdirSync(DEBUG_DIR);
  if (files.length === 0) {
    console.log("No debug files to remove.");
    return;
  }
  let removed = 0;
  files.forEach((file) => {
    if (file.endsWith(".json")) {
      fs.unlinkSync(path.join(DEBUG_DIR, file));
      removed += 1;
    }
  });
  console.log(`Removed ${removed} debug file(s).`);
}

function findAllValuesByKey(obj, key) {
  const results = [];
  if (Array.isArray(obj)) {
    obj.forEach((item) => results.push(...findAllValuesByKey(item, key)));
  } else if (obj && typeof obj === "object") {
    Object.entries(obj).forEach(([k, v]) => {
      if (k === key) {
        results.push(v);
      }
      results.push(...findAllValuesByKey(v, key));
    });
  }
  return results;
}

function findFirstValueByKey(obj, key) {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstValueByKey(item, key);
      if (found !== undefined) return found;
    }
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (k === key) return v;
      const found = findFirstValueByKey(v, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findTeamByKey(obj, teamKey) {
  const teamNodes = findAllValuesByKey(obj, "team");
  for (const teamNode of teamNodes) {
    if (Array.isArray(teamNode)) {
      const key =
        findFirstValueByKey(teamNode[0], "team_key") ??
        findFirstValueByKey(teamNode, "team_key");
      if (key === teamKey) return teamNode;
    } else if (teamNode && typeof teamNode === "object") {
      const key =
        teamNode.team_key ?? findFirstValueByKey(teamNode, "team_key");
      if (key === teamKey) return teamNode;
    }
  }
  return null;
}

function normalizeStatName(name) {
  if (!name) return "";
  return name.toString().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveStatIdByAliases(statNameMap, aliases) {
  const normalizedAliases = aliases.map(normalizeStatName);
  for (const [statId, statName] of statNameMap.entries()) {
    const normalizedStatName = normalizeStatName(statName);
    if (normalizedAliases.includes(normalizedStatName)) {
      return statId.toString();
    }
  }
  return null;
}

function extractStatName(entry) {
  if (!entry || typeof entry !== "object") return null;
  return (
    entry.name ||
    entry.display_name ||
    entry.stat_name ||
    entry.stat_display_name ||
    entry.abbr ||
    null
  );
}

function extractStatValue(stat) {
  if (!stat || typeof stat !== "object") return null;
  const value = stat.value ?? stat.stat_value ?? stat.display_value ?? null;
  if (value && typeof value === "object") {
    return (
      value.value ??
      value.text ??
      value.display ??
      value.raw ??
      value.amount ??
      null
    );
  }
  return value ?? null;
}

function extractStatRank(stat) {
  if (!stat || typeof stat !== "object") return null;
  const rank = stat.rank ?? stat.points ?? stat.rank_value ?? null;
  if (rank && typeof rank === "object") {
    return rank.value ?? rank.points ?? rank.raw ?? rank.text ?? null;
  }
  return rank ?? null;
}

function extractStatId(stat) {
  if (!stat || typeof stat !== "object") return null;
  const id = stat.stat_id ?? stat.statid ?? null;
  if (id && typeof id === "object") {
    return id.value ?? id.id ?? id.text ?? null;
  }
  if (id === undefined || id === null) return null;
  return id.toString();
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function extractPlayerName(player) {
  if (!player) return "Unknown";
  const nameObj = findFirstValueByKey(player, "name");
  if (typeof nameObj === "string") return nameObj;
  if (nameObj && typeof nameObj === "object") {
    return (
      nameObj.full ||
      nameObj.full_name ||
      nameObj.name ||
      (nameObj.first && nameObj.last
        ? `${nameObj.first} ${nameObj.last}`
        : nameObj.first || nameObj.last) ||
      "Unknown"
    );
  }
  const full = findFirstValueByKey(player, "full");
  if (typeof full === "string") return full;
  return "Unknown";
}

function extractPlayerPositions(player) {
  if (!player) return [];
  const display = findFirstValueByKey(player, "display_position");
  if (Array.isArray(display)) return display;
  if (typeof display === "string") return display.split(",").map((p) => p.trim());
  const position = findFirstValueByKey(player, "position");
  if (Array.isArray(position)) return position;
  if (typeof position === "string") return position.split(",").map((p) => p.trim());
  return [];
}

function extractSelectedPositions(player) {
  if (!player) return [];
  const selected = findFirstValueByKey(player, "selected_position");
  if (Array.isArray(selected)) {
    return selected
      .map((item) =>
        item && typeof item === "object" ? item.position ?? item.pos : item
      )
      .filter(Boolean)
      .map((pos) => pos.toString());
  }
  if (selected && typeof selected === "object") {
    const pos = selected.position ?? selected.pos ?? null;
    return pos ? [pos.toString()] : [];
  }
  if (typeof selected === "string") return [selected];
  return [];
}

function extractPlayerStatus(player) {
  if (!player) return null;
  const statuses = findAllValuesByKey(player, "status");
  const status = statuses.find(
    (value) => typeof value === "string" && value.trim() !== ""
  );
  return status ?? null;
}

function extractPlayerRank(player) {
  const rank =
    findFirstValueByKey(player, "editorial_player_rank") ??
    findFirstValueByKey(player, "editorial_rank") ??
    findFirstValueByKey(player, "rank");
  return toNumber(rank);
}

function extractPlayerKey(player) {
  const key = findFirstValueByKey(player, "player_key");
  return typeof key === "string" ? key : null;
}

function extractPlayerId(player) {
  const id = findFirstValueByKey(player, "player_id");
  if (id === undefined || id === null) return null;
  return id.toString();
}

function extractPlayerTeamAbbr(player) {
  const abbr = findFirstValueByKey(player, "editorial_team_abbr");
  return typeof abbr === "string" ? abbr.toUpperCase() : null;
}

function extractPlayerTeamName(player) {
  const name = findFirstValueByKey(player, "editorial_team_full_name");
  return typeof name === "string" ? name : null;
}

function extractPrimarySelectedPosition(selected) {
  if (!selected || selected.length === 0) return null;
  return selected[0] || null;
}

function buildRosterState(rosterPlayers) {
  return rosterPlayers
    .map((player) => {
      const playerKey = extractPlayerKey(player);
      if (!playerKey) return null;
      const name = extractPlayerName(player);
      const selected = extractSelectedPositions(player);
      const positions = extractPlayerPositions(player);
      const status = extractPlayerStatus(player);
      return {
        playerKey,
        name,
        selected,
        selectedPrimary: extractPrimarySelectedPosition(selected),
        positions,
        status,
        teamAbbr: extractPlayerTeamAbbr(player),
        teamName: extractPlayerTeamName(player),
        isPitcher: isPitcherPositions(positions),
        isIL: isILPosition(selected) || isILStatus(status),
      };
    })
    .filter(Boolean);
}

function countBy(items, getKey) {
  const out = {};
  (items || []).forEach((item) => {
    const key = getKey(item);
    if (!key) return;
    out[key] = (out[key] || 0) + 1;
  });
  return out;
}

function buildSnapshotFeatures({
  leagueSettingsFile,
  resolvedCategories,
  focusKeys,
  targetModel,
  startContext,
  startDiagnostics,
  pointInfoByKey,
  categoryNextGaps,
  rosterMappedPlayers,
  startPlans,
  actionSuggestions,
  actionDetails,
  dropSuggestions,
  addCandidates,
  dropDiagnostics,
}) {
  const roster = Array.isArray(rosterMappedPlayers) ? rosterMappedPlayers : [];
  const actions = actionSuggestions || {};
  const details = actionDetails || {};
  const rosterSlot = (p) => p.selectedPrimary || extractPrimarySelectedPosition(p.selected) || "UNK";
  const rosterBySlot = countBy(roster, rosterSlot);
  const rosterByStatus = countBy(roster, (p) => p.status || "ACTIVE");
  const active = roster.filter((p) => !isBenchPosition(p.selected || []) && !p.isIL);
  const bench = roster.filter((p) => isBenchPosition(p.selected || []));
  const unavailable = roster.filter((p) => p.isIL || isUnavailableStatus(p.status));
  const pitchers = roster.filter((p) => p.isPitcher);
  const hitters = roster.filter((p) => !p.isPitcher);
  const projectedAdds = [
    ...(details.addBatting || []),
    ...(details.addPitching || []),
    ...(details.add || []),
  ];
  const addPool = Array.isArray(addCandidates) ? addCandidates : [];

  const categoryState = {};
  (resolvedCategories || []).forEach((cat) => {
    const pointInfo = pointInfoByKey?.get?.(cat.key) || null;
    const gap = categoryNextGaps?.[cat.key] || null;
    categoryState[cat.key] = {
      points: toNumber(cat.points),
      rank: toNumber(cat.rank),
      value: toNumber(cat.value),
      focus: Array.isArray(focusKeys) ? focusKeys.includes(cat.key) : false,
      nextGap: gap
        ? {
            deltaToNext: toNumber(gap.deltaToNext),
            pointsGainToNext: toNumber(gap.pointsGainToNext),
            status: gap.status || null,
          }
        : null,
      pointInfo: pointInfo
        ? {
            pointsGain: toNumber(pointInfo.pointsGain),
            deltaToNext: toNumber(pointInfo.deltaToNext),
            nextTeamKey: pointInfo.nextTeamKey || null,
            nextTeamName: pointInfo.nextTeamName || null,
          }
        : null,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: {
      yahooRoster: roster.length > 0,
      yahooPlayerRanks: roster.some((p) => p.rank !== null && p.rank !== undefined),
      yahooPlayerStats: roster.some((p) => p.stats && p.stats.size > 0),
      externalSchedule: !!startContext?.scheduleAvailable,
      externalProjections: false,
      externalNews: false,
    },
    categoryState,
    rosterComposition: {
      total: roster.length,
      active: active.length,
      bench: bench.length,
      il: roster.filter((p) => p.isIL).length,
      unavailable: unavailable.length,
      pitchers: pitchers.length,
      hitters: hitters.length,
      bySlot: rosterBySlot,
      byStatus: rosterByStatus,
    },
    playerAvailability: unavailable.map((p) => ({
      playerKey: p.playerKey || null,
      name: p.name,
      status: p.status || null,
      selectedPrimary: p.selectedPrimary || null,
      positions: p.positions || [],
    })),
    scheduleProxy: {
      source: startContext?.scheduleAvailable ? "mlb-statsapi-schedule" : "lineup-slots",
      dateRange: startContext?.dateRange || null,
      rosterChanges: leagueSettingsFile?.rosterChanges || null,
      activePitchers: active
        .filter((p) => p.isPitcher)
        .map((p) => ({
          playerKey: p.playerKey || null,
          name: p.name,
          slot: rosterSlot(p),
          positions: p.positions || [],
          status: p.status || null,
        })),
      recommendedStarts: (startPlans || []).map((p) => ({
        playerKey: p.playerKey || null,
        name: p.name,
        startSlot: p.startSlot || null,
        benchName: p.benchName || null,
        benchSlot: p.benchSlot || null,
        score: toNumber(p.startScore),
        reasons: p.startReasons || [],
      })),
    },
    recommendationContext: {
      targetModel: targetModel || "baseline",
      counts: {
        addBatting: actions.addBatting?.length || 0,
        addPitching: actions.addPitching?.length || 0,
        add: actions.add?.length || 0,
        start: actions.start?.length || 0,
        drop: actions.drop?.length || 0,
      },
      candidatePool: {
        adds: addPool.length,
        drops: Array.isArray(dropSuggestions) ? dropSuggestions.length : 0,
        projectedAdds: projectedAdds.length,
        archetypeTaggedAdds: projectedAdds.filter((d) => d.archetype).length,
      },
      protectedInjuryReviews: dropDiagnostics?.protectedInjuryReviews || [],
      dropDiagnostics: dropDiagnostics || null,
      startDiagnostics: startDiagnostics || null,
      addDetails: projectedAdds.map((d) => ({
        playerKey: d.playerKey || null,
        playerName: d.playerName || null,
        positions: d.positions || [],
        targetCategories: d.targetCategories || [],
        pairedDrop: d.pairedDrop || null,
        archetype: d.archetype || null,
        archetypeFitScore: toNumber(d.archetypeFitScore),
        statsScore: toNumber(d.statsScore),
        yahooRank: toNumber(d.yahooRank),
      })),
      dropDetails: (details.drop || []).map((d) => ({
        playerKey: d.playerKey || null,
        playerName: d.playerName || null,
        positions: d.positions || [],
        status: d.status || null,
        statusDrop: !!d.statusDrop,
        injuryReview: d.injuryReview || null,
        statsScore: toNumber(d.statsScore),
        yahooRank: toNumber(d.yahooRank),
      })),
    },
  };
}

function isBenchSelectedPositions(selected) {
  return Array.isArray(selected) && selected.some((pos) => ["BN", "BE"].includes(pos));
}

function extractPlayerStats(player) {
  const statsContainer = findFirstValueByKey(player, "player_stats");
  const statsEntries = extractStatEntries(
    statsContainer?.stats ?? statsContainer
  ).filter((stat) => extractStatId(stat));
  const map = new Map();
  statsEntries.forEach((stat) => {
    const statId = extractStatId(stat);
    let rawValue = extractStatValue(stat);
    if (rawValue === "-" || rawValue === "") {
      rawValue = 0;
    }
    const value = toNumber(rawValue);
    if (statId && value !== null) {
      map.set(statId, value);
    }
  });
  return map;
}

function isPitcherPositions(positions) {
  return positions.some((pos) => ["SP", "RP", "P"].includes(pos));
}

function isPitcherFilter(positionFilter) {
  return ["SP", "RP", "P"].includes(positionFilter);
}

function positionMatches(positions, positionFilter) {
  if (!positionFilter) return true;
  return positions.includes(positionFilter);
}

function isCatcherPositions(positions) {
  return positions.some((pos) => pos === "C");
}

function isBenchPosition(positions) {
  return positions.some((pos) => ["BN", "BE"].includes(pos));
}

function normalizeSlot(slot) {
  if (!slot) return null;
  const s = String(slot).trim();
  return s ? s.toUpperCase() : null;
}

function isNonBenchSlot(slot) {
  const s = normalizeSlot(slot);
  if (!s) return false;
  return !["BN", "BE", "IL", "IL+", "IR"].includes(s);
}

function canUseSlot(player, slot) {
  const s = normalizeSlot(slot);
  if (!s || !isNonBenchSlot(s)) return false;
  if (s === "UTIL") return !player.isPitcher;
  if (s === "P") return !!player.isPitcher;
  const eligible = (player.positions || []).map((p) => normalizeSlot(p)).filter(Boolean);
  return eligible.includes(s);
}

function computeLineupOpenSlots(rosterPositions, mappedPlayers) {
  const openSlots = [];
  if (!Array.isArray(rosterPositions) || rosterPositions.length === 0) return openSlots;
  const cap = new Map();
  rosterPositions.forEach((slot) => {
    const s = normalizeSlot(slot);
    if (!s || !isNonBenchSlot(s)) return;
    cap.set(s, (cap.get(s) || 0) + 1);
  });

  const used = new Map();
  (mappedPlayers || []).forEach((p) => {
    const slot = normalizeSlot(extractPrimarySelectedPosition(p.selected));
    if (!slot || !isNonBenchSlot(slot)) return;
    used.set(slot, (used.get(slot) || 0) + 1);
  });

  cap.forEach((count, slot) => {
    const remaining = count - (used.get(slot) || 0);
    for (let i = 0; i < remaining; i += 1) openSlots.push(slot);
  });

  return openSlots;
}

function preferredStartSlots(player) {
  const eligible = (player.positions || []).map((p) => normalizeSlot(p)).filter(Boolean);
  const seen = new Set();
  const out = [];
  const push = (s) => {
    const v = normalizeSlot(s);
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  if (player.isPitcher) {
    // Prefer role slots before generic P.
    eligible.forEach((s) => {
      if (s === "SP" || s === "RP") push(s);
    });
    push("P");
    eligible.forEach((s) => push(s));
    return out;
  }

  eligible.forEach((s) => push(s));
  push("UTIL");
  return out;
}

function pickWorstStarter(starters, statKeys, statIdByKey) {
  if (!starters || starters.length === 0) return null;
  const scored = starters.map((p) => {
    const startScore = toNumber(p.startScore);
    const score = computeStatScore(p.stats, statKeys, statIdByKey);
    const rank = p.rank === null || p.rank === undefined ? 9999 : p.rank;
    return {
      p,
      startScore,
      score: score === null || score === undefined ? Number.NEGATIVE_INFINITY : score,
      rank,
    };
  });
  scored.sort((a, b) => {
    if (a.startScore !== null && b.startScore !== null && a.startScore !== b.startScore) {
      return a.startScore - b.startScore;
    }
    if (a.score !== b.score) return a.score - b.score; // lower = worse
    return b.rank - a.rank; // higher rank number = worse
  });
  return scored[0]?.p || null;
}

function buildStartPlans({
  startSelections,
  rosterMappedPlayers,
  rosterPositions,
  battingCategories,
  pitchingCategories,
  focusKeys,
  statIdByKey,
}) {
  const plans = [];
  if (!Array.isArray(startSelections) || startSelections.length === 0) return plans;
  const roster = Array.isArray(rosterMappedPlayers) ? rosterMappedPlayers : [];

  const starters = roster.filter((p) => {
    const slot = normalizeSlot(extractPrimarySelectedPosition(p.selected));
    return slot && isNonBenchSlot(slot) && !p.isIL;
  });

  const openSlots = computeLineupOpenSlots(rosterPositions, roster);
  const remainingOpenSlots = openSlots.slice();
  const usedBenchKeys = new Set();
  const minStartUpgrade = 1.5;

  const focusSet = new Set(Array.isArray(focusKeys) ? focusKeys : []);
  const statKeysFor = (isPitcher) => {
    const cats = isPitcher ? pitchingCategories : battingCategories;
    const focused = cats.filter((k) => focusSet.has(k));
    return focused.length > 0 ? focused : cats;
  };

  // Build fast lookup by slot.
  const startersBySlot = new Map();
  starters.forEach((p) => {
    const slot = normalizeSlot(extractPrimarySelectedPosition(p.selected));
    if (!slot) return;
    if (!startersBySlot.has(slot)) startersBySlot.set(slot, []);
    startersBySlot.get(slot).push(p);
  });

  const takeOpenSlot = (preferredSlots, player) => {
    for (let i = 0; i < preferredSlots.length; i += 1) {
      const slot = preferredSlots[i];
      if (!canUseSlot(player, slot)) continue;
      const idx = remainingOpenSlots.findIndex((s) => s === slot);
      if (idx !== -1) {
        remainingOpenSlots.splice(idx, 1);
        return slot;
      }
    }
    return null;
  };

  const pickBenchForSlot = (slot, player) => {
    const list = startersBySlot.get(slot) || [];
    const playerScore = toNumber(player.startScore);
    const filtered = list.filter((p) => {
      if (!p.playerKey || usedBenchKeys.has(p.playerKey)) return false;
      if (isUnavailableStatus(p.status) || p.isIL) return true;
      const benchScore = toNumber(p.startScore);
      if (playerScore === null || benchScore === null) return true;
      return playerScore - benchScore >= minStartUpgrade;
    });
    if (filtered.length === 0) return null;
    const bench = pickWorstStarter(filtered, statKeysFor(player.isPitcher), statIdByKey);
    if (bench?.playerKey) usedBenchKeys.add(bench.playerKey);
    return bench || null;
  };

  startSelections.forEach((player) => {
    const preferred = preferredStartSlots(player);

    const open = takeOpenSlot(preferred, player);
    if (open) {
      plans.push({
        name: player.name,
        playerKey: player.playerKey,
        startSlot: open,
        benchName: null,
        benchSlot: null,
        note: "open slot",
      });
      return;
    }

    // Replace the worst starter in any slot we can play.
    let best = null;
    preferred.forEach((slot) => {
      if (!canUseSlot(player, slot)) return;
      const bench = pickBenchForSlot(slot, player);
      if (!bench) return;
      best = best || { slot, bench };
      // Prefer benching an unavailable player if possible.
      const benchUnavailable = isUnavailableStatus(bench.status) || bench.isIL;
      if (benchUnavailable) best = { slot, bench };
    });

    if (best) {
      plans.push({
        name: player.name,
        playerKey: player.playerKey,
        startSlot: best.slot,
        benchName: best.bench.name,
        benchSlot: normalizeSlot(extractPrimarySelectedPosition(best.bench.selected)),
        note: null,
      });
      return;
    }

    // Fallback: no clear swap found.
    plans.push({
      name: player.name,
      playerKey: player.playerKey,
      startSlot: null,
      benchName: null,
      benchSlot: null,
      note: "no eligible slot found",
    });
  });

  return plans;
}

function isILStatus(status) {
  if (!status) return false;
  const normalized = status.toString().trim().toUpperCase();
  return normalized.startsWith("IL") || normalized === "IR";
}

function isUnavailableStatus(status) {
  if (!status) return false;
  const normalized = status.toString().trim().toUpperCase();
  return (
    normalized.startsWith("IL") ||
    normalized === "IR" ||
    normalized === "NA" ||
    normalized === "DTD"
  );
}

function isDropStatus(status) {
  if (!status) return false;
  const normalized = status.toString().trim().toUpperCase();
  // Droppable statuses: long/unknown absences. (DTD is too noisy and can include studs.)
  return normalized.startsWith("IL") || normalized === "IR" || normalized === "NA";
}

function normalizeNameKey(name) {
  return String(name || "").trim().toLowerCase();
}

function parseReviewDate(reviewedAt) {
  if (!reviewedAt) return null;
  return parseIsoDate(String(reviewedAt).slice(0, 10));
}

function injuryReviewMaxAgeDays(config) {
  const configured = toNumber(config?.protectedInjuryReviewMaxAgeDays);
  if (configured !== null && configured >= 0) return configured;
  return PROTECTED_INJURY_REVIEW_MAX_AGE_DAYS;
}

function injuryReviewHasEvidence(review) {
  if (!review || typeof review !== "object") return false;
  const sources = Array.isArray(review.sources)
    ? review.sources.filter((source) => String(source || "").trim() !== "")
    : [];
  const notes = String(review.notes || "").trim();
  return sources.length > 0 || notes.length > 0;
}

function injuryReviewSaysOutBeyond30Days(review) {
  if (!review || typeof review !== "object") return false;
  const expectedOutDays = toNumber(
    review.expectedOutDays ?? review.expectedDaysOut ?? review.daysOut
  );
  const probabilityBackWithin30Days = toNumber(review.probabilityBackWithin30Days);
  return (
    review.likelyOutMoreThan30Days === true ||
    review.likelyBackWithin30Days === false ||
    (expectedOutDays !== null && expectedOutDays > 30) ||
    (probabilityBackWithin30Days !== null && probabilityBackWithin30Days < 0.5)
  );
}

function isRecentInjuryReview(config, review) {
  const reviewedDate = parseReviewDate(review?.reviewedAt);
  const today = parseIsoDate(todayDateString());
  if (!reviewedDate || !today) return false;
  const ageDays = daysBetweenUtc(reviewedDate, today);
  return ageDays >= 0 && ageDays <= injuryReviewMaxAgeDays(config);
}

function injuryReviewAgeDays(review) {
  const reviewedDate = parseReviewDate(review?.reviewedAt);
  const today = parseIsoDate(todayDateString());
  if (!reviewedDate || !today) return null;
  return daysBetweenUtc(reviewedDate, today);
}

function reviewMatchesPlayer(review, player) {
  const reviewName = normalizeNameKey(review?.playerName ?? review?.name);
  const playerName = normalizeNameKey(player?.name);
  if (reviewName && playerName && reviewName === playerName) return true;
  const reviewPlayerKey = String(review?.playerKey || "").trim();
  return Boolean(reviewPlayerKey && player?.playerKey && reviewPlayerKey === player.playerKey);
}

function findLatestInjuryDropReview(config, player) {
  const reviews = Array.isArray(config?.injuryDropReviews)
    ? config.injuryDropReviews
    : [];
  return reviews
    .filter((review) => reviewMatchesPlayer(review, player))
    .sort((a, b) =>
      String(b?.reviewedAt || "").localeCompare(String(a?.reviewedAt || ""))
    )[0] || null;
}

function getProtectedInjuryReviewState(config, player) {
  const review = findLatestInjuryDropReview(config, player);
  const maxAgeDays = injuryReviewMaxAgeDays(config);
  const reviewAgeDays = injuryReviewAgeDays(review);
  const hasReview = !!review;
  const reviewedAllInjuryNews = review?.reviewedAllInjuryNews === true;
  const hasEvidence = injuryReviewHasEvidence(review);
  const saysOutBeyond30Days = injuryReviewSaysOutBeyond30Days(review);
  const isRecent =
    reviewAgeDays !== null && reviewAgeDays >= 0 && reviewAgeDays <= maxAgeDays;
  let reviewStatus = "missing";
  let reason = "No injury review on file.";

  if (hasReview) {
    if (!reviewedAllInjuryNews || !hasEvidence) {
      reviewStatus = "incomplete";
      reason = "Review exists but is missing all-news confirmation or evidence.";
    } else if (!saysOutBeyond30Days) {
      reviewStatus = "not_out_beyond_30";
      reason = "Review does not say the player is more likely than not out beyond 30 days.";
    } else if (!isRecent) {
      reviewStatus = "stale";
      reason = `Review is older than ${maxAgeDays} days.`;
    } else {
      reviewStatus = "eligible";
      reason = "Recent review supports more-likely-than-not absence beyond 30 days.";
    }
  }

  return {
    playerKey: player?.playerKey || null,
    name: player?.name || null,
    status: player?.status || null,
    selectedPrimary:
      player?.selectedPrimary || extractPrimarySelectedPosition(player?.selected || []),
    positions: player?.positions || [],
    reviewStatus,
    dropEligible: reviewStatus === "eligible",
    reviewedAt: review?.reviewedAt || null,
    reviewAgeDays,
    maxAgeDays,
    reviewedAllInjuryNews,
    expectedOutDays: review ? toNumber(review.expectedOutDays) : null,
    likelyBackWithin30Days:
      typeof review?.likelyBackWithin30Days === "boolean"
        ? review.likelyBackWithin30Days
        : null,
    likelyOutMoreThan30Days:
      typeof review?.likelyOutMoreThan30Days === "boolean"
        ? review.likelyOutMoreThan30Days
        : null,
    sourceCount: Array.isArray(review?.sources)
      ? review.sources.filter((source) => String(source || "").trim() !== "").length
      : 0,
    hasNotes: String(review?.notes || "").trim() !== "",
    reason,
  };
}

function getAllowedProtectedInjuryDropReview(config, player) {
  if (!player || player.isPitcher) return null;
  if (!(isILStatus(player.status) || player.isIL)) return null;
  const review = findLatestInjuryDropReview(config, player);
  return getProtectedInjuryReviewState(config, player).dropEligible
    ? review
    : null;
}

function isDropBlockedByDoNotDrop(config, doNotDrop, player) {
  if (!doNotDrop.has(normalizeNameKey(player?.name))) return false;
  return !getAllowedProtectedInjuryDropReview(config, player);
}

function addBlockMatchesPlayer(block, player) {
  const blockName = normalizeNameKey(block?.playerName ?? block?.name ?? block);
  const playerName = normalizeNameKey(player?.name);
  if (blockName && playerName && blockName === playerName) return true;
  const blockPlayerKey = String(block?.playerKey || "").trim();
  return Boolean(blockPlayerKey && player?.playerKey && blockPlayerKey === player.playerKey);
}

function addBlockIsActive(block) {
  if (!block || typeof block !== "object") return true;
  const until = parseIsoDate(String(block.unavailableUntil || block.until || "").slice(0, 10));
  if (!until) return true;
  const today = parseIsoDate(todayDateString());
  return !today || daysBetweenUtc(today, until) >= 0;
}

function getAddBlock(config, player) {
  const blocks = [
    ...(Array.isArray(config?.doNotAdd) ? config.doNotAdd : []),
    ...(Array.isArray(config?.unavailableAdds) ? config.unavailableAdds : []),
  ];
  return (
    blocks.find((block) => addBlockMatchesPlayer(block, player) && addBlockIsActive(block)) ||
    null
  );
}

function buildProtectedInjuryReviewStates(config, doNotDrop, roster) {
  return (Array.isArray(roster) ? roster : [])
    .filter(
      (player) =>
        doNotDrop.has(normalizeNameKey(player?.name)) &&
        !player.isPitcher &&
        (player.isIL || isILStatus(player.status))
    )
    .map((player) => getProtectedInjuryReviewState(config, player));
}

function isILPosition(positions) {
  return positions.some((pos) => ["IL", "IL+", "IR"].includes(pos));
}

function playerKey(player) {
  const positions = Array.isArray(player.positions) ? player.positions.join(",") : "";
  return `${player.name}|${positions}`;
}

async function fetchRosterWithStats({ accessToken, teamKey }) {
  const statTypes = ["lastmonth", "lastweek", "season"];
  for (const statType of statTypes) {
    try {
      const roster = await yahooRequest({
        url: `${FANTASY_API_BASE}/team/${teamKey}/roster;out=stats;type=${statType}?format=json`,
        accessToken,
      });
      return { roster, statType, hasStats: true };
    } catch (error) {
      // try next stat type
    }
  }

  const roster = await yahooRequest({
    url: `${FANTASY_API_BASE}/team/${teamKey}/roster?format=json`,
    accessToken,
  });
  return { roster, statType: null, hasStats: false };
}

async function fetchRosterForDate({ accessToken, teamKey, dateStr }) {
  const roster = await yahooRequest({
    url: `${FANTASY_API_BASE}/team/${teamKey}/roster;date=${dateStr}?format=json`,
    accessToken,
  });
  return roster;
}

async function fetchPlayerStatsByKeys({ accessToken, playerKeys, statTypeOverride = null }) {
  const statTypes = statTypeOverride ? [statTypeOverride] : ["lastmonth", "lastweek", "season"];
  if (!playerKeys || playerKeys.length === 0) {
    return { statsByKey: new Map(), statType: null, hasStats: false };
  }
  for (const statType of statTypes) {
    try {
      const statsByKey = new Map();
      const chunks = chunkArray(playerKeys, 25);
      for (let idx = 0; idx < chunks.length; idx += 1) {
        const chunk = chunks[idx];
        const keyParam = encodeURIComponent(chunk.join(","));
        const data = await yahooRequest({
          url: `${FANTASY_API_BASE}/players;player_keys=${keyParam}/stats;type=${statType}?format=json`,
          accessToken,
        });
        writeDebugJson(`player-stats-${statType}-${idx + 1}`, data);
        const playerNodes = findAllValuesByKey(data, "player");
        playerNodes.forEach((player) => {
          const key = extractPlayerKey(player);
          if (!key) return;
          const stats = extractPlayerStats(player);
          if (stats.size > 0) {
            statsByKey.set(key, stats);
          }
        });
      }
      return { statsByKey, statType, hasStats: statsByKey.size > 0 };
    } catch (error) {
      // try next stat type
    }
  }
  return { statsByKey: new Map(), statType: null, hasStats: false };
}

async function fetchPlayerSeasonStatsByKeys({ accessToken, playerKeys, season }) {
  if (!playerKeys || playerKeys.length === 0) {
    return { statsByKey: new Map(), season, hasStats: false };
  }
  const statsByKey = new Map();
  const chunks = chunkArray(playerKeys, 25);
  for (const chunk of chunks) {
    const keyParam = encodeURIComponent(chunk.join(","));
    const data = await yahooRequest({
      url: `${FANTASY_API_BASE}/players;player_keys=${keyParam}/stats;type=season;season=${season}?format=json`,
      accessToken,
    });
    writeDebugJson(`player-stats-season-${season}`, data);
    const playerNodes = findAllValuesByKey(data, "player");
    playerNodes.forEach((player) => {
      const key = extractPlayerKey(player);
      if (!key) return;
      const stats = extractPlayerStats(player);
      if (stats.size > 0) {
        statsByKey.set(key, stats);
      }
    });
  }
  return { statsByKey, season, hasStats: statsByKey.size > 0 };
}

async function fetchPlayerHistory({ accessToken, playerKeys, endSeasonYear, seasonsBack }) {
  const years = [];
  for (let i = 1; i <= seasonsBack; i += 1) {
    years.push(endSeasonYear - i);
  }
  const byKey = new Map();
  for (const year of years) {
    try {
      const result = await fetchPlayerSeasonStatsByKeys({
        accessToken,
        playerKeys,
        season: year,
      });
      result.statsByKey.forEach((stats, key) => {
        if (!byKey.has(key)) byKey.set(key, new Map());
        byKey.get(key).set(year, stats);
      });
    } catch {
      // ignore missing historical season responses
    }
  }
  return byKey;
}

function getHistoryBackfillSeasons() {
  const explicit = getArgValue("--seasons");
  if (explicit) {
    const seasons = explicit
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((year) => Number.isInteger(year) && year > 1900);
    if (seasons.length > 0) return seasons;
  }
  const count = Math.max(1, Math.floor(Number(getArgValue("--years")) || 5));
  const nowYear = new Date().getFullYear();
  const lastComplete = process.argv.includes("--include-current") ? nowYear : nowYear - 1;
  return Array.from({ length: count }, (_, idx) => lastComplete - idx).reverse();
}

function getHistoryPageLimit() {
  const raw = getArgValue("--max-pages");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function getHistoryPlayerLimit() {
  const raw = getArgValue("--limit");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function extractGameKeyForSeason(payload, season) {
  const games = findAllValuesByKey(payload, "game");
  for (const game of games) {
    const gameSeason = findFirstValueByKey(game, "season");
    const gameKey = findFirstValueByKey(game, "game_key");
    if (String(gameSeason) === String(season) && gameKey) return String(gameKey);
  }
  const fallback = findFirstValueByKey(payload, "game_key");
  return fallback ? String(fallback) : null;
}

async function fetchGameKeyForSeason({ accessToken, season, gameCode = "mlb" }) {
  const data = await yahooRequest({
    url: `${FANTASY_API_BASE}/games;game_codes=${gameCode};seasons=${season}?format=json`,
    accessToken,
  });
  writeDebugJson(`historical-game-${season}`, data);
  const gameKey = extractGameKeyForSeason(data, season);
  if (!gameKey) throw new Error(`Could not find Yahoo game key for ${gameCode} ${season}`);
  return { gameKey, raw: data };
}

async function fetchHistoricalPlayersPage({ accessToken, gameKey, start, count }) {
  let data = null;
  let statsByKey = new Map();
  try {
    data = await yahooRequest({
      url: `${FANTASY_API_BASE}/game/${gameKey}/players;start=${start};count=${count}/stats;type=season?format=json`,
      accessToken,
    });
  } catch {
    data = await yahooRequest({
      url: `${FANTASY_API_BASE}/game/${gameKey}/players;start=${start};count=${count}?format=json`,
      accessToken,
    });
    const playerKeys = findAllValuesByKey(data, "player")
      .map((player) => extractPlayerKey(player))
      .filter(Boolean);
    for (const playerKeyValue of playerKeys) {
      try {
        const statData = await yahooRequest({
          url: `${FANTASY_API_BASE}/player/${playerKeyValue}/stats;type=season?format=json`,
          accessToken,
        });
        const statPlayer = findAllValuesByKey(statData, "player").find(
          (player) => extractPlayerKey(player) === playerKeyValue
        );
        const stats = extractPlayerStats(statPlayer);
        if (stats.size > 0) statsByKey.set(playerKeyValue, stats);
      } catch {
        // Some old Yahoo player keys no longer resolve; keep bio row and skip stats.
      }
    }
  }
  writeDebugJson(`historical-players-${gameKey}-${start}`, data);
  const players = findAllValuesByKey(data, "player")
    .filter((player) => extractPlayerKey(player))
    .filter((player, idx, arr) => {
      const key = extractPlayerKey(player);
      return arr.findIndex((candidate) => extractPlayerKey(candidate) === key) === idx;
    });
  return { data, players, statsByKey };
}

async function writeHistoricalPlayerPoolToDb({
  season,
  gameKey,
  players,
  statsByKey,
  pageCount,
  rawSummary,
}) {
  const db = await getDb();
  const fetchedAt = new Date().toISOString();
  db.exec("BEGIN;");
  try {
    runStmt(
      db,
      `INSERT OR REPLACE INTO historical_player_pools (
        season, game_key, fetched_at, player_count, page_count, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [season, gameKey, fetchedAt, players.length, pageCount, jsonText(rawSummary || {})]
    );

    runStmt(db, "DELETE FROM historical_players WHERE season = ? AND game_key = ?", [
      season,
      gameKey,
    ]);
    runStmt(db, "DELETE FROM historical_player_stats WHERE season = ? AND game_key = ?", [
      season,
      gameKey,
    ]);

    players.forEach((player) => {
      const playerKeyValue = extractPlayerKey(player);
      if (!playerKeyValue) return;
      const stats = statsByKey?.get(playerKeyValue) || extractPlayerStats(player);
      runStmt(
        db,
        `INSERT OR REPLACE INTO historical_players (
          season, game_key, player_key, player_id, name, positions_json,
          status, yahoo_rank, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          season,
          gameKey,
          playerKeyValue,
          extractPlayerId(player),
          extractPlayerName(player),
          jsonText(extractPlayerPositions(player)),
          extractPlayerStatus(player),
          toNumber(extractPlayerRank(player)),
          jsonText(player),
        ]
      );
      stats.forEach((value, statId) => {
        runStmt(
          db,
          `INSERT OR REPLACE INTO historical_player_stats (
            season, game_key, player_key, stat_id, value, raw_value
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [season, gameKey, playerKeyValue, statId, toNumber(value), String(value)]
        );
      });
    });

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

async function backfillHistoricalPlayerSeason({ accessToken, season, gameKey }) {
  const pageSize = 25;
  const maxPages = getHistoryPageLimit();
  const playerLimit = getHistoryPlayerLimit();
  const playersByKey = new Map();
  const statsByKey = new Map();
  const rawSummary = { season, gameKey, pages: [] };
  let pageCount = 0;
  let consecutiveEmptyPages = 0;

  for (let start = 0; ; start += pageSize) {
    if (maxPages && pageCount >= maxPages) break;
    if (playerLimit && playersByKey.size >= playerLimit) break;
    let page = null;
    try {
      page = await fetchHistoricalPlayersPage({
        accessToken,
        gameKey,
        start,
        count: pageSize,
      });
    } catch (error) {
      pageCount += 1;
      rawSummary.pages.push({
        start,
        count: 0,
        skipped: true,
        error: error.message.slice(0, 240),
      });
      consecutiveEmptyPages += 1;
      if (consecutiveEmptyPages >= 4) break;
      continue;
    }
    const { data, players, statsByKey: pageStatsByKey } = page;
    pageCount += 1;
    rawSummary.pages.push({ start, count: players.length });
    consecutiveEmptyPages = players.length === 0 ? consecutiveEmptyPages + 1 : 0;
    players.forEach((player) => {
      const key = extractPlayerKey(player);
      if (key && (!playerLimit || playersByKey.size < playerLimit)) {
        playersByKey.set(key, player);
      }
    });
    pageStatsByKey.forEach((stats, key) => statsByKey.set(key, stats));
    if (consecutiveEmptyPages >= 4) break;
    if (players.length < pageSize) break;
    const collectionCount = toNumber(findFirstValueByKey(data, "count"));
    if (collectionCount !== null && players.length === 0) break;
  }

  const players = [...playersByKey.values()];
  await writeHistoricalPlayerPoolToDb({
    season,
    gameKey,
    players,
    statsByKey,
    pageCount,
    rawSummary,
  });
  return { season, gameKey, playerCount: players.length, pageCount };
}

async function discoverHistoricalLeagues({ accessToken, gameKey }) {
  try {
    const data = await yahooRequest({
      url: `${FANTASY_API_BASE}/users;use_login=1/games;game_keys=${gameKey}/leagues/teams?format=json`,
      accessToken,
    });
    writeDebugJson(`historical-leagues-${gameKey}`, data);
    return {
      raw: data,
      leagueKeys: [...new Set(findAllValuesByKey(data, "league_key"))],
      teamKeys: [...new Set(findAllValuesByKey(data, "team_key"))],
    };
  } catch {
    return { raw: null, leagueKeys: [], teamKeys: [] };
  }
}

async function writeHistoricalLeagueToDb({ season, gameKey, leagueKey, teamKey, raw, standings }) {
  const db = await getDb();
  const fetchedAt = new Date().toISOString();
  db.exec("BEGIN;");
  try {
    runStmt(
      db,
      `INSERT OR REPLACE INTO historical_leagues (
        season, game_key, league_key, team_key, fetched_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [season, gameKey, leagueKey, teamKey || null, fetchedAt, jsonText(raw || {})]
    );
    runStmt(
      db,
      "DELETE FROM historical_team_category_stats WHERE season = ? AND league_key = ?",
      [season, leagueKey]
    );
    const teams = buildTeamMetrics(standings || {});
    teams.forEach((team) => {
      team.statsById.forEach((stat, statId) => {
        const pointStat = team.pointsById.get(statId);
        runStmt(
          db,
          `INSERT OR REPLACE INTO historical_team_category_stats (
            season, league_key, team_key, team_name, stat_id, value, points
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            season,
            leagueKey,
            team.teamKey,
            team.teamName || null,
            statId,
            toNumber(extractStatValue(stat)),
            toNumber(extractStatValue(pointStat)),
          ]
        );
      });
    });
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

async function backfillHistoricalLeagues({ accessToken, season, gameKey }) {
  const discovered = await discoverHistoricalLeagues({ accessToken, gameKey });
  const results = [];
  for (const leagueKey of discovered.leagueKeys) {
    try {
      const standings = await yahooRequest({
        url: `${FANTASY_API_BASE}/league/${leagueKey}/standings?format=json`,
        accessToken,
      });
      writeDebugJson(`historical-standings-${season}-${leagueKey}`, standings);
      await writeHistoricalLeagueToDb({
        season,
        gameKey,
        leagueKey,
        teamKey: discovered.teamKeys[0] || null,
        raw: discovered.raw,
        standings,
      });
      results.push({ leagueKey, teams: buildTeamMetrics(standings).length });
    } catch (error) {
      results.push({ leagueKey, error: error.message });
    }
  }
  return results;
}

async function historyBackfill() {
  const config = loadConfig();
  const accessToken = await getAccessToken(config);
  const seasons = getHistoryBackfillSeasons();
  const skipLeagues = process.argv.includes("--players-only");
  const results = [];

  console.log(`Historical backfill seasons: ${seasons.join(", ")}`);
  for (const season of seasons) {
    const { gameKey } = await fetchGameKeyForSeason({
      accessToken,
      season,
      gameCode: config.gameKey || "mlb",
    });
    console.log(`Season ${season}: game key ${gameKey}`);
    const playerResult = await backfillHistoricalPlayerSeason({
      accessToken,
      season,
      gameKey,
    });
    console.log(
      `- players: ${playerResult.playerCount} over ${playerResult.pageCount} page(s)`
    );
    let leagueResults = [];
    if (!skipLeagues) {
      leagueResults = await backfillHistoricalLeagues({ accessToken, season, gameKey });
      if (leagueResults.length > 0) {
        leagueResults.forEach((league) => {
          if (league.error) {
            console.log(`- league ${league.leagueKey}: ${league.error}`);
          } else {
            console.log(`- league ${league.leagueKey}: ${league.teams} team(s)`);
          }
        });
      } else {
        console.log("- leagues: none discovered for this account/season");
      }
    }
    results.push({ ...playerResult, leagues: leagueResults });
  }

  console.log(`Historical backfill complete: ${DB_PATH}`);
  return results;
}

function buildStatIdByKey(resolvedCategories) {
  const map = new Map();
  resolvedCategories.forEach((cat) => {
    if (cat.statId) {
      map.set(cat.key, cat.statId);
    }
  });
  return map;
}

function buildLeagueStandingsSurface({
  resolvedCategories,
  teamMetrics,
  totalPointsByTeam,
}) {
  const teams = Array.isArray(teamMetrics) ? teamMetrics : [];
  const teamCount = teams.length;
  return {
    schemaVersion: 1,
    categories: (resolvedCategories || [])
      .filter((cat) => cat?.key && cat?.statId)
      .map((cat) => {
        const statId = String(cat.statId);
        const categoryTeams = teams
          .map((team) => {
            const value = toNumber(extractStatValue(team.statsById?.get(statId)));
            const points = toNumber(extractStatValue(team.pointsById?.get(statId)));
            const rank =
              points !== null && teamCount > 0
                ? Math.round((teamCount - points + 1) * 10) / 10
                : null;
            return {
              teamKey: team.teamKey,
              teamName: team.teamName,
              value,
              points,
              rank,
              totalPoints: toNumber(totalPointsByTeam?.get?.(team.teamKey)),
            };
          })
          .filter((team) => team.teamKey)
          .sort((a, b) => {
            const ap = toNumber(a.points) ?? -Infinity;
            const bp = toNumber(b.points) ?? -Infinity;
            if (bp !== ap) return bp - ap;
            const av = toNumber(a.value) ?? 0;
            const bv = toNumber(b.value) ?? 0;
            return isLowerBetter(cat.key, cat.name) ? av - bv : bv - av;
          });
        return {
          key: cat.key,
          statId,
          name: cat.name || cat.key,
          direction: isLowerBetter(cat.key, cat.name)
            ? "lower_is_better"
            : "higher_is_better",
          teams: categoryTeams,
        };
      }),
  };
}

function buildSnapshot({
  config,
  overallRank,
  seasonProgress,
  gpValue,
  ipValue,
  gpCap,
  ipCap,
  resolvedCategories,
  targetKeys,
  bestValueTargets,
  focusKeys,
  pointsToNextTeam,
  categoryNextGaps,
  leagueStandings,
  actionSuggestions,
  actionDetails,
  rosterState,
  featureInputs,
}) {
  const snapshotId = new Date().toISOString();
  const categories = resolvedCategories.map((cat) => ({
    key: cat.key,
    statId: cat.statId,
    name: cat.name,
    value: toNumber(cat.value),
    points: toNumber(cat.points),
    rank: cat.rank,
    rankSource: cat.rankSource,
  }));
  return {
    id: snapshotId,
    date: todayDateString(),
    timestamp: snapshotId,
    leagueKey: config.leagueKey,
    teamKey: config.teamKey,
    leagueName: config.leagueName || null,
    teamName: config.teamName || null,
    overallRank,
    seasonProgress,
    gpValue,
    gpCap,
    ipValue,
    ipCap,
    pointsToNextTeam: pointsToNextTeam || null,
    categoryNextGaps: categoryNextGaps || null,
    leagueStandings: leagueStandings || null,
    targets: Array.isArray(targetKeys) ? targetKeys : [],
    focusTargets: Array.isArray(focusKeys) ? focusKeys : [],
    bestValueTargets,
    categories,
    actions: actionSuggestions,
    actionDetails: actionDetails || {},
    roster: rosterState || [],
    featureInputs: featureInputs || null,
  };
}

function inferActions(prevSnapshot, currentSnapshot) {
  if (!prevSnapshot?.roster || !currentSnapshot?.roster) return null;
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
      if (prevBench && !currBench) {
        starts.push(curr.name);
      } else if (!prevBench && currBench) {
        benches.push(curr.name);
      }
    }
  });

  prevMap.forEach((prev, key) => {
    if (!currMap.has(key)) {
      drops.push(prev.name);
    }
  });

  if (adds.length === 0 && drops.length === 0 && starts.length === 0 && benches.length === 0) {
    return null;
  }

  return {
    id: `inferred-${currentSnapshot.id}`,
    date: currentSnapshot.date,
    snapshotId: prevSnapshot.id,
    adds,
    drops,
    starts,
    benches,
    notes: "Inferred from roster changes.",
    source: "inferred",
  };
}

function isReadyForEffectiveness(baseSnapshot, currentSnapshot) {
  if (!baseSnapshot || !currentSnapshot) return false;
  if (baseSnapshot.id === currentSnapshot.id) return false;
  if (baseSnapshot.date && currentSnapshot.date) {
    const baseDate = parseIsoDate(baseSnapshot.date);
    const currentDate = parseIsoDate(currentSnapshot.date);
    if (baseDate && currentDate) {
      return daysBetweenUtc(baseDate, currentDate) >= EFFECTIVENESS_DELAY_DAYS;
    }
  }
  return true;
}

function findLatestReadySnapshot({ snapshots, currentSnapshot, lastEvaluatedSnapshotId }) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return null;
  const lastEvaluatedIndex = lastEvaluatedSnapshotId
    ? snapshots.findIndex((snap) => snap.id === lastEvaluatedSnapshotId)
    : -1;
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const snapshot = snapshots[i];
    if (!snapshot || snapshot.id === currentSnapshot.id) continue;
    if (lastEvaluatedIndex >= 0 && i <= lastEvaluatedIndex) continue;
    if (!isReadyForEffectiveness(snapshot, currentSnapshot)) continue;
    return snapshot;
  }
  return null;
}

function evaluateActions({ learning, actions, snapshots, currentSnapshot }) {
  const safeActions = Array.isArray(actions) ? actions : [];
  const snapshotMap = new Map(snapshots.map((snap) => [snap.id, snap]));
  const lastEvaluatedId = learning.lastEvaluatedActionId;
  let pending = null;
  const lastEvaluatedActionIndex = lastEvaluatedId
    ? safeActions.findIndex((action) => action.id === lastEvaluatedId)
    : -1;
  for (let i = safeActions.length - 1; i > lastEvaluatedActionIndex; i -= 1) {
    const action = safeActions[i];
    if (
      action.id !== lastEvaluatedId &&
      action.snapshotId &&
      action.snapshotId !== currentSnapshot.id
    ) {
      const actionSnapshot = snapshotMap.get(action.snapshotId);
      if (!isReadyForEffectiveness(actionSnapshot, currentSnapshot)) continue;
      pending = action;
      break;
    }
  }

  let source = "manual";
  const readySnapshot = findLatestReadySnapshot({
    snapshots,
    currentSnapshot,
    lastEvaluatedSnapshotId: learning.lastEvaluatedSnapshotId,
  });
  if (!pending) {
    if (readySnapshot) {
      pending = inferActions(readySnapshot, currentSnapshot);
      source = "inferred";
    }
  }
  if (!pending) {
    if (readySnapshot) {
      pending = {
        id: `targets-${currentSnapshot.id}`,
        date: currentSnapshot.date,
        snapshotId: readySnapshot.id,
        adds: [],
        drops: [],
        starts: [],
        benches: [],
        notes: "No actions logged; evaluated target movement only.",
        source: "targets",
      };
      source = "targets";
    }
  }
  if (!pending) return learning;

  const baseSnapshot = snapshotMap.get(pending.snapshotId);
  if (!baseSnapshot) return learning;
  if (!isReadyForEffectiveness(baseSnapshot, currentSnapshot)) return learning;

  const currentMap = new Map(
    currentSnapshot.categories.map((cat) => [cat.key, cat])
  );
  const baseMap = new Map(baseSnapshot.categories.map((cat) => [cat.key, cat]));
  const boosts = { ...(learning.categoryBoost || {}) };
  const adherence = computeStartAdherence(baseSnapshot, currentSnapshot);
  const adherenceFactor =
    adherence && adherence.recommendedCount > 0
      ? 0.3 + 0.7 * adherence.adherence
      : 1;
  const lines = [];

  lines.push(`## ${currentSnapshot.date}`);
  lines.push(`Actions applied (snapshot ${pending.snapshotId}, ${source}):`);
  const formatList = (label, items) => {
    if (!items || items.length === 0) return;
    lines.push(`- ${label}: ${items.join(", ")}`);
  };
  formatList("ADD", pending.adds);
  formatList("DROP", pending.drops);
  formatList("START", pending.starts);
  formatList("BENCH", pending.benches);
  if (pending.notes) {
    lines.push(`- Notes: ${pending.notes}`);
  }
  if (adherence && adherence.recommendedCount > 0) {
    lines.push(
      `- Lineup adherence: ${adherence.matched}/${adherence.recommendedCount} recommended starts used`
    );
  }
  lines.push("Effectiveness:");

  const targetKeys = baseSnapshot.focusTargets || baseSnapshot.targets || [];
  targetKeys.forEach((key) => {
    const baseCat = baseMap.get(key);
    const curCat = currentMap.get(key);
    if (!baseCat || !curCat) return;
    const deltaValue = (curCat.value ?? 0) - (baseCat.value ?? 0);
    const deltaPoints = (curCat.points ?? 0) - (baseCat.points ?? 0);
    const lowerBetter = isLowerBetter(key, baseCat.name || key);
    const improved =
      deltaPoints > 0 || (lowerBetter ? deltaValue < 0 : deltaValue > 0);
    if (!boosts[key]) boosts[key] = 0;
    const delta =
      source === "targets"
        ? improved
          ? 0.3
          : -0.1
        : improved
          ? 0.5
          : -0.2;
    boosts[key] += delta * adherenceFactor;
    lines.push(
      `- ${key}: value ${deltaValue >= 0 ? "+" : ""}${deltaValue}, points ${
        deltaPoints >= 0 ? "+" : ""
      }${deltaPoints} (${improved ? "improved" : "no gain"})`
    );
  });

  appendDailyLog(lines);

  return {
    categoryBoost: boosts,
    lastEvaluatedActionId: source === "manual" ? pending.id : learning.lastEvaluatedActionId,
    lastEvaluatedSnapshotId: source === "manual" ? learning.lastEvaluatedSnapshotId : pending.snapshotId,
  };
}

function extractStatEntries(container) {
  if (!container) return [];
  if (Array.isArray(container)) {
    return container
      .map((item) => (item && typeof item === "object" && "stat" in item ? item.stat : item))
      .filter(Boolean);
  }
  if (typeof container === "object") {
    if (Array.isArray(container.stats)) return extractStatEntries(container.stats);
    if (Array.isArray(container.stat)) return extractStatEntries(container.stat);
  }
  return [];
}

function roundRank(value) {
  if (value === null || value === undefined) return null;
  return Math.round(value);
}

function formatRank(value) {
  if (value === null || value === undefined) return "N/A";
  const rounded = roundRank(value);
  return Number.isNaN(rounded) ? "N/A" : `${rounded}`;
}

function statPrecision(statKey) {
  if (["AVG", "ERA", "WHIP"].includes(statKey)) return 3;
  return 0;
}

function formatStatValue(value, statKey) {
  if (value === null || value === undefined) return "N/A";
  if (typeof value === "number") {
    const precision = statPrecision(statKey);
    return precision > 0 ? value.toFixed(precision) : `${Math.round(value)}`;
  }
  return `${value}`;
}

function buildEffectivenessSummary(snapshots, currentSnapshot) {
  if (!snapshots || snapshots.length < 2) return null;
  // Compare against the most recent snapshot from a *different date*.
  // Users often run `recommend` multiple times per day, and comparing
  // "last run" can incorrectly report 0 adherence if no lineup changes occurred
  // between two runs on the same date.
  let prevSnapshot = null;
  for (let i = snapshots.length - 2; i >= 0; i -= 1) {
    const s = snapshots[i];
    if (!s || s.id === currentSnapshot.id) continue;
    if (s.date && currentSnapshot.date && s.date === currentSnapshot.date) continue;
    prevSnapshot = s;
    break;
  }
  if (!prevSnapshot) return null;

  const adherenceCandidates = [];
  for (let i = snapshots.length - 2; i >= 0; i -= 1) {
    const s = snapshots[i];
    if (!s || s.id === currentSnapshot.id) continue;
    if (s.date && currentSnapshot.date && s.date === currentSnapshot.date) continue;
    if (prevSnapshot.date && s.date && s.date !== prevSnapshot.date) continue;
    if (Array.isArray(s.actions?.start) && s.actions.start.length > 0) {
      adherenceCandidates.push(s);
    }
  }
  let adherenceBaseSnapshot = prevSnapshot;
  let adherence = null;
  if (adherenceCandidates.length > 0) {
    const scored = adherenceCandidates.map((snapshot, idx) => ({
      snapshot,
      idx,
      adherence: computeStartAdherence(snapshot, currentSnapshot),
    }));
    scored.sort((a, b) => {
      const matchedDelta = (b.adherence?.matched || 0) - (a.adherence?.matched || 0);
      if (matchedDelta !== 0) return matchedDelta;
      const countDelta =
        (b.adherence?.recommendedCount || 0) - (a.adherence?.recommendedCount || 0);
      if (countDelta !== 0) return countDelta;
      return a.idx - b.idx;
    });
    adherenceBaseSnapshot = scored[0].snapshot;
    adherence = scored[0].adherence;
  } else {
    adherence = computeStartAdherence(adherenceBaseSnapshot, currentSnapshot);
  }
  const startOutcome = buildStartOutcomeAttribution(adherenceBaseSnapshot, currentSnapshot);

  const lines = [];
  if (adherence && adherence.recommendedCount > 0) {
    lines.push(
      `- Lineup adherence: ${adherence.matched}/${adherence.recommendedCount} recommended starts used`
    );
    if (adherenceCandidates.length > 1) {
      lines.push(
        `- Adherence baseline: ${adherenceBaseSnapshot.id} (best match among ${adherenceCandidates.length} recommendation runs on ${adherenceBaseSnapshot.date})`
      );
    }
    if (adherence.matched < adherence.recommendedCount) {
      const recommended = adherenceBaseSnapshot.actions?.start || [];
      const prevByName = new Map((adherenceBaseSnapshot.roster || []).map((p) => [p.name, p]));
      const currByName = new Map((currentSnapshot.roster || []).map((p) => [p.name, p]));
      recommended.slice(0, 5).forEach((name) => {
        const a = prevByName.get(name);
        const b = currByName.get(name);
        const prevSlot = a?.selectedPrimary || (a?.selected?.[0] ?? null);
        const currSlot = b?.selectedPrimary || (b?.selected?.[0] ?? null);
        if (!prevSlot && !currSlot) return;
        lines.push(`- Adherence detail: ${name} ${prevSlot || "?"} -> ${currSlot || "?"}`);
      });
    }
    if (startOutcome) {
      lines.push(
        `- Start outcome: target points ${signedText(startOutcome.targetPointDelta, 1)}, non-target points ${signedText(startOutcome.nonTargetPointDelta, 1)}, gap closed ${signedText(startOutcome.gapClosed, 1)}`
      );
      startOutcome.starts
        .filter((start) => start.riskFlags.length > 0)
        .slice(0, 3)
        .forEach((start) => {
          lines.push(`- Start risk: ${start.playerName} (${start.riskFlags.join("; ")})`);
        });
    }
  }
  const prevRank = toNumber(prevSnapshot.overallRank);
  const currRank = toNumber(currentSnapshot.overallRank);
  if (prevRank !== null && currRank !== null) {
    const delta = prevRank - currRank;
    const deltaText =
      delta === 0 ? "no change" : delta > 0 ? `+${delta}` : `${delta}`;
    lines.push(`- Overall rank: ${prevRank} -> ${currRank} (${deltaText})`);
  }

  const prevMap = new Map(prevSnapshot.categories.map((cat) => [cat.key, cat]));
  const currMap = new Map(currentSnapshot.categories.map((cat) => [cat.key, cat]));
  const targetKeys = prevSnapshot.focusTargets || prevSnapshot.targets || [];
  if (targetKeys.length > 0) {
    targetKeys.forEach((key) => {
      const prevCat = prevMap.get(key);
      const currCat = currMap.get(key);
      if (!prevCat || !currCat) return;
      const deltaPoints = (currCat.points ?? 0) - (prevCat.points ?? 0);
      const deltaValue = (currCat.value ?? 0) - (prevCat.value ?? 0);
      const deltaPointsText =
        deltaPoints === 0 ? "0" : deltaPoints > 0 ? `+${deltaPoints}` : `${deltaPoints}`;
      const deltaValueText =
        deltaValue === 0
          ? "0"
          : deltaValue > 0
            ? `+${formatStatValue(deltaValue, key)}`
            : `${formatStatValue(deltaValue, key)}`;
      lines.push(`- ${key}: value ${deltaValueText}, points ${deltaPointsText}`);
    });
  }

  return lines.length > 0 ? lines : null;
}

function targetsImproved(baseSnapshot, currentSnapshot) {
  if (!baseSnapshot || !currentSnapshot) return false;
  const targetKeys = baseSnapshot.focusTargets || baseSnapshot.targets || [];
  if (targetKeys.length === 0) return false;
  const currentMap = new Map(
    currentSnapshot.categories.map((cat) => [cat.key, cat])
  );
  const baseMap = new Map(baseSnapshot.categories.map((cat) => [cat.key, cat]));
  return targetKeys.some((key) => {
    const baseCat = baseMap.get(key);
    const curCat = currentMap.get(key);
    if (!baseCat || !curCat) return false;
    const deltaValue = (curCat.value ?? 0) - (baseCat.value ?? 0);
    const deltaPoints = (curCat.points ?? 0) - (baseCat.points ?? 0);
    const lowerBetter = isLowerBetter(key, baseCat.name || key);
    return (
      deltaPoints > 0 || (lowerBetter ? deltaValue < 0 : deltaValue > 0)
    );
  });
}

function computeStartAdherence(baseSnapshot, currentSnapshot) {
  if (!baseSnapshot || !currentSnapshot) return null;
  const recommended = baseSnapshot.actions?.start || [];
  if (!Array.isArray(recommended) || recommended.length === 0) {
    return { recommendedCount: 0, matched: 0, adherence: 1 };
  }

  // Two notions of "used":
  // 1) inferred start (player moved from BN -> active between snapshots)
  // 2) active now (player is currently in an active slot)
  // We report inferredStarts for debugging, but count a recommendation as "used" if it is
  // active now OR it was inferred as started (covers cases where player stays active across runs).
  const inferred = inferActions(baseSnapshot, currentSnapshot);
  const inferredStarts = new Set(inferred?.starts || []);

  const isBench = (selected) =>
    Array.isArray(selected) &&
    selected.some((pos) => ["BN", "BE"].includes(String(pos).toUpperCase()));
  const activeNow = new Set(
    (currentSnapshot.roster || [])
      .filter((p) => !isBench(p.selected))
      .map((p) => p.name)
  );

  const matched = recommended.filter(
    (name) => inferredStarts.has(name) || activeNow.has(name)
  ).length;
  const adherence = recommended.length > 0 ? matched / recommended.length : 1;
  return {
    recommendedCount: recommended.length,
    matched,
    adherence,
    debug: {
      inferredStarts: [...inferredStarts],
      activeNowMatches: recommended.filter((name) => activeNow.has(name)),
    },
  };
}

function startRiskAssessment({ schedule, focusKeys = [] }) {
  const focusSet = new Set(Array.isArray(focusKeys) ? focusKeys : []);
  const era = toNumber(schedule?.era);
  const whip = toNumber(schedule?.whip);
  const projectedIp = toNumber(schedule?.projectedIp) ?? 0;
  const flags = [];
  let penalty = 0;

  if (focusSet.has("ERA") && era !== null) {
    if (era >= 5.5) {
      flags.push(`high ERA risk ${era}`);
      penalty += 12;
    } else if (era >= 4.8) {
      flags.push(`elevated ERA risk ${era}`);
      penalty += 6;
    }
  }
  if (focusSet.has("WHIP") && whip !== null) {
    if (whip >= 1.35) {
      flags.push(`high WHIP risk ${whip}`);
      penalty += 12;
    } else if (whip >= 1.25) {
      flags.push(`elevated WHIP risk ${whip}`);
      penalty += 5;
    }
  }
  if ((focusSet.has("ERA") || focusSet.has("WHIP")) && projectedIp >= 5 && flags.length > 0) {
    flags.push(`bulk innings exposure ${projectedIp}`);
    penalty += 4;
  }

  return { flags, penalty };
}

function startDetailsForSnapshot(snapshot) {
  const details = Array.isArray(snapshot?.actionDetails?.start)
    ? snapshot.actionDetails.start
    : [];
  if (details.length > 0) return details;
  return (snapshot?.actions?.start || []).map((name) => ({ playerName: name }));
}

function buildStartOutcomeAttribution(baseSnapshot, currentSnapshot) {
  const details = startDetailsForSnapshot(baseSnapshot);
  if (details.length === 0) return null;
  const adherence = computeStartAdherence(baseSnapshot, currentSnapshot);
  const targetKeys = baseSnapshot.focusTargets || baseSnapshot.targets || [];
  const allKeys = (baseSnapshot.categories || []).map((cat) => cat.key);
  const targetSet = new Set(targetKeys);
  const targetPointDelta = targetKeys.reduce(
    (sum, key) => sum + (categoryPointDelta(baseSnapshot, currentSnapshot, key) ?? 0),
    0
  );
  const nonTargetPointDelta = allKeys
    .filter((key) => !targetSet.has(key))
    .reduce((sum, key) => sum + (categoryPointDelta(baseSnapshot, currentSnapshot, key) ?? 0), 0);
  const totalPointDelta = appTotalPoints(currentSnapshot) - appTotalPoints(baseSnapshot);
  const inferredStarts = new Set(adherence?.debug?.inferredStarts || []);
  const activeNow = new Set(adherence?.debug?.activeNowMatches || []);
  const focusKeys = baseSnapshot.focusTargets || baseSnapshot.targets || [];

  return {
    targetPointDelta,
    nonTargetPointDelta,
    totalPointDelta,
    gapClosed: gapClosed(baseSnapshot, currentSnapshot),
    estimatedNextTeamPointDelta: approximateNextTeamPointDelta(baseSnapshot, currentSnapshot),
    starts: details.map((detail) => {
      const playerName = detail.playerName || detail.name || "Unknown";
      const risk = startRiskAssessment({ schedule: detail.schedule, focusKeys });
      return {
        playerName,
        used: inferredStarts.has(playerName) || activeNow.has(playerName),
        score: toNumber(detail.score),
        targetCategories: detail.targetCategories || [],
        schedule: detail.schedule || null,
        riskFlags: risk.flags,
        riskPenalty: risk.penalty,
      };
    }),
  };
}

function latestSnapshotsByDate(snapshots) {
  const byDate = new Map();
  (snapshots || [])
    .slice()
    .sort((a, b) => String(a.timestamp || a.id || a.date).localeCompare(String(b.timestamp || b.id || b.date)))
    .forEach((snapshot) => {
      if (!snapshot?.date) return;
      byDate.set(snapshot.date, snapshot);
    });
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function snapshotCategoryMap(snapshot) {
  const out = new Map();
  (snapshot?.categories || []).forEach((cat) => {
    if (!cat?.key) return;
    out.set(cat.key, cat);
  });
  return out;
}

function categoryPointDelta(fromSnapshot, toSnapshot, key) {
  const fromCat = snapshotCategoryMap(fromSnapshot).get(key);
  const toCat = snapshotCategoryMap(toSnapshot).get(key);
  if (!fromCat || !toCat) return null;
  const before = toNumber(fromCat.points);
  const after = toNumber(toCat.points);
  if (before === null || after === null) return null;
  return after - before;
}

function categoryValueDelta(fromSnapshot, toSnapshot, key) {
  const fromCat = snapshotCategoryMap(fromSnapshot).get(key);
  const toCat = snapshotCategoryMap(toSnapshot).get(key);
  if (!fromCat || !toCat) return null;
  const before = toNumber(fromCat.value);
  const after = toNumber(toCat.value);
  if (before === null || after === null) return null;
  return after - before;
}

function signedText(value, digits = 1) {
  const n = toNumber(value);
  if (n === null) return "n/a";
  const text = Number.isInteger(n) ? `${n}` : n.toFixed(digits);
  return n > 0 ? `+${text}` : text;
}

function rankDelta(fromSnapshot, toSnapshot) {
  const before = toNumber(fromSnapshot?.overallRank);
  const after = toNumber(toSnapshot?.overallRank);
  if (before === null || after === null) return null;
  return before - after;
}

function gapToNext(snapshot) {
  return toNumber(snapshot?.pointsToNextTeam?.delta);
}

function gapClosed(fromSnapshot, toSnapshot) {
  const before = gapToNext(fromSnapshot);
  const after = gapToNext(toSnapshot);
  if (before === null || after === null) return null;
  return before - after;
}

function approximateNextTeamPointDelta(fromSnapshot, toSnapshot) {
  const beforeGap = gapToNext(fromSnapshot);
  const afterGap = gapToNext(toSnapshot);
  if (beforeGap === null || afterGap === null) return null;
  const myDelta = appTotalPoints(toSnapshot) - appTotalPoints(fromSnapshot);
  return afterGap - beforeGap + myDelta;
}

function recommendationConstraints(snapshot) {
  const rec = snapshot?.featureInputs?.recommendationContext || {};
  const diagnostics = rec.dropDiagnostics || {};
  const counts = rec.counts || {};
  const candidatePool = rec.candidatePool || {};
  const addCandidateCount =
    toNumber(diagnostics.addCandidateCount) ??
    toNumber(candidatePool.adds) ??
    ((snapshot?.actions?.add || []).length +
      (snapshot?.actions?.addBatting || []).length +
      (snapshot?.actions?.addPitching || []).length);
  const safeDropCandidates =
    toNumber(diagnostics.safeDropCandidates) ??
    toNumber(candidatePool.drops) ??
    (snapshot?.actions?.drop || []).length;
  const blockedProtectedDrops = Array.isArray(diagnostics.blockedProtectedDrops)
    ? diagnostics.blockedProtectedDrops.length
    : 0;
  const staleProtectedInjuryReviews = Array.isArray(diagnostics.staleProtectedInjuryReviews)
    ? diagnostics.staleProtectedInjuryReviews.length
    : 0;
  const addBlockedByDrops = addCandidateCount > 0 && safeDropCandidates === 0;
  return {
    targetModel: rec.targetModel || "baseline",
    recommendedAdds:
      (counts.add || 0) + (counts.addBatting || 0) + (counts.addPitching || 0),
    recommendedStarts: counts.start || (snapshot?.actions?.start || []).length,
    recommendedDrops: counts.drop || (snapshot?.actions?.drop || []).length,
    addCandidateCount,
    safeDropCandidates,
    blockedProtectedDrops,
    staleProtectedInjuryReviews,
    addBlockedByDrops,
  };
}

function transitionAttribution(fromSnapshot, toSnapshot) {
  const targets = fromSnapshot?.focusTargets || fromSnapshot?.targets || [];
  const pointDeltas = targets
    .map((key) => categoryPointDelta(fromSnapshot, toSnapshot, key))
    .filter((value) => value !== null);
  const targetPointDelta = pointDeltas.reduce((sum, value) => sum + value, 0);
  const targetDetails = targets.map((key) => ({
    key,
    pointDelta: categoryPointDelta(fromSnapshot, toSnapshot, key),
    valueDelta: categoryValueDelta(fromSnapshot, toSnapshot, key),
  }));
  const adherence = computeStartAdherence(fromSnapshot, toSnapshot);
  const startOutcome = buildStartOutcomeAttribution(fromSnapshot, toSnapshot);
  const constraints = recommendationConstraints(fromSnapshot);
  const myPointDelta = appTotalPoints(toSnapshot) - appTotalPoints(fromSnapshot);
  const nextTeamPointDelta = approximateNextTeamPointDelta(fromSnapshot, toSnapshot);
  const gapDelta = gapClosed(fromSnapshot, toSnapshot);
  const drivers = [];

  if (constraints.addBlockedByDrops) {
    drivers.push(`${constraints.addCandidateCount} add candidates but 0 safe drops`);
  }
  if (constraints.blockedProtectedDrops > 0) {
    drivers.push(`${constraints.blockedProtectedDrops} protected drop blocks`);
  }
  if (gapDelta !== null && myPointDelta !== null && nextTeamPointDelta !== null) {
    if (gapDelta < 0 && nextTeamPointDelta > myPointDelta) {
      drivers.push(`next team gained about ${signedText(nextTeamPointDelta - myPointDelta)} more points than us`);
    } else if (gapDelta > 0) {
      drivers.push(`closed gap by ${signedText(gapDelta)}`);
    }
  }
  return {
    fromDate: fromSnapshot?.date || null,
    toDate: toSnapshot?.date || null,
    fromSnapshotId: fromSnapshot?.id || null,
    toSnapshotId: toSnapshot?.id || null,
    rankBefore: fromSnapshot?.overallRank ?? null,
    rankAfter: toSnapshot?.overallRank ?? null,
    rankDelta: rankDelta(fromSnapshot, toSnapshot),
    gapBefore: gapToNext(fromSnapshot),
    gapAfter: gapToNext(toSnapshot),
    gapClosed: gapDelta,
    myPointDelta,
    nextTeamPointDelta,
    targetModel: constraints.targetModel,
    targets,
    targetPointDelta,
    targetDetails,
    adherence,
    startOutcome,
    constraints,
    drivers,
  };
}

function horizonOutcome(dailySnapshots, horizonDays) {
  if (!Array.isArray(dailySnapshots) || dailySnapshots.length <= horizonDays) {
    return null;
  }
  const rows = [];
  for (let i = 0; i < dailySnapshots.length - horizonDays; i += 1) {
    rows.push(transitionAttribution(dailySnapshots[i], dailySnapshots[i + horizonDays]));
  }
  const validGapRows = rows.filter((row) => row.gapClosed !== null);
  const validRankRows = rows.filter((row) => row.rankDelta !== null);
  const validTargetRows = rows.filter((row) => row.targetPointDelta !== null);
  return {
    days: horizonDays,
    n: rows.length,
    meanGapClosed: validGapRows.length
      ? validGapRows.reduce((sum, row) => sum + row.gapClosed, 0) / validGapRows.length
      : null,
    meanRankDelta: validRankRows.length
      ? validRankRows.reduce((sum, row) => sum + row.rankDelta, 0) / validRankRows.length
      : null,
    rankImproveRate: validRankRows.length
      ? validRankRows.filter((row) => row.rankDelta > 0).length / validRankRows.length
      : null,
    meanTargetPointDelta: validTargetRows.length
      ? validTargetRows.reduce((sum, row) => sum + row.targetPointDelta, 0) / validTargetRows.length
      : null,
  };
}

function latestOpportunityMatrix(snapshot, previousSnapshots = []) {
  const latest = snapshot;
  const previous = previousSnapshots[previousSnapshots.length - 1] || null;
  const ptn = latest?.pointsToNextTeam || {};
  const nextTeamKey = ptn.nextTeamKey || null;
  return (latest?.categories || [])
    .map((cat) => {
      const gap = latest?.categoryNextGaps?.[cat.key] || {};
      const points = toNumber(cat.points) ?? 0;
      const pointsGainToNext = toNumber(gap.pointsGainToNext) ?? 0;
      const deltaToNext = toNumber(gap.deltaToNext);
      const recentPointDelta = previous ? categoryPointDelta(previous, latest, cat.key) : null;
      let score = 0;
      if (points <= 3) score += 4;
      else if (points <= 5) score += 2;
      if (String(gap.status || "") === "chasing" && pointsGainToNext > 0) score += Math.min(4, pointsGainToNext);
      if (nextTeamKey && gap.nextTeamKey && nextTeamKey === gap.nextTeamKey) score += 3;
      if (deltaToNext !== null) {
        score += Math.max(0, 2 - Math.min(2, Math.abs(deltaToNext) / Math.max(1, statUnitScale(cat.key))));
      }
      if (recentPointDelta !== null && recentPointDelta < 0) score += 1;
      return {
        key: cat.key,
        name: cat.name || cat.key,
        points,
        rank: toNumber(cat.rank),
        value: toNumber(cat.value),
        status: gap.status || null,
        nextTeamName: gap.nextTeamName || null,
        nextTeamKey: gap.nextTeamKey || null,
        versusNextTeamAbove: !!(nextTeamKey && gap.nextTeamKey && nextTeamKey === gap.nextTeamKey),
        deltaToNext,
        pointsGainToNext,
        recentPointDelta,
        opportunityScore: score,
      };
    })
    .sort((a, b) => b.opportunityScore - a.opportunityScore);
}

function buildRankReview(snapshots, { days = 14, horizons = [1, 3, 7] } = {}) {
  const daily = latestSnapshotsByDate(snapshots);
  const latest = daily[daily.length - 1] || null;
  const window = daily.slice(Math.max(0, daily.length - Math.max(days + 1, 2)));
  const transitions = [];
  for (let i = 1; i < window.length; i += 1) {
    transitions.push(transitionAttribution(window[i - 1], window[i]));
  }
  const allTransitions = [];
  for (let i = 1; i < daily.length; i += 1) {
    allTransitions.push(transitionAttribution(daily[i - 1], daily[i]));
  }
  const latestTransition = transitions[transitions.length - 1] || null;
  const blockedDays = transitions.filter((row) => row.constraints.addBlockedByDrops).length;
  const adherenceRows = transitions.filter((row) => row.adherence && row.adherence.recommendedCount > 0);
  const adherenceRate = adherenceRows.length
    ? adherenceRows.reduce((sum, row) => sum + row.adherence.adherence, 0) / adherenceRows.length
    : null;
  const totalGapClosed = transitions
    .filter((row) => row.gapClosed !== null)
    .reduce((sum, row) => sum + row.gapClosed, 0);
  const totalMyPointDelta = transitions.reduce((sum, row) => sum + row.myPointDelta, 0);
  const totalNextTeamPointDelta = transitions
    .filter((row) => row.nextTeamPointDelta !== null)
    .reduce((sum, row) => sum + row.nextTeamPointDelta, 0);
  const latestIdx = daily.length - 1;
  const opportunityMatrix = latest
    ? latestOpportunityMatrix(latest, daily.slice(Math.max(0, latestIdx - 7), latestIdx))
    : [];

  return {
    generatedAt: new Date().toISOString(),
    window: {
      days,
      from: window[0]?.date || null,
      to: latest?.date || null,
      dailySnapshots: window.length,
      totalDailySnapshots: daily.length,
    },
    latest: latest
      ? {
          date: latest.date,
          snapshotId: latest.id || null,
          rank: latest.overallRank ?? null,
          totalPoints: appTotalPoints(latest),
          pointsToNextTeam: latest.pointsToNextTeam || null,
          targets: latest.focusTargets || latest.targets || [],
          targetModel: latest.featureInputs?.recommendationContext?.targetModel || "baseline",
        }
      : null,
    summary: {
      rankChanged: transitions.some((row) => row.rankDelta && row.rankDelta !== 0),
      totalGapClosed,
      totalMyPointDelta,
      totalNextTeamPointDelta,
      adherenceRate,
      blockedDays,
      evaluatedDays: transitions.length,
    },
    latestTransition,
    transitions,
    horizons: horizons.map((horizon) => horizonOutcome(daily, horizon)).filter(Boolean),
    opportunityMatrix,
    recommendations: rankReviewRecommendations({
      transitions,
      latestTransition,
      opportunityMatrix,
      adherenceRate,
      blockedDays,
    }),
    allTransitions,
  };
}

function rankReviewRecommendations({ transitions, latestTransition, opportunityMatrix, adherenceRate, blockedDays }) {
  const recs = [];
  if (adherenceRate !== null && adherenceRate < 0.75) {
    recs.push({
      priority: "high",
      title: "Fix lineup execution before changing models",
      detail: `Average recommended-start adherence in the review window is ${(adherenceRate * 100).toFixed(0)}%. A model cannot improve standings if starts are not applied.`,
    });
  }
  if (blockedDays > 0) {
    recs.push({
      priority: "high",
      title: "Resolve safe-drop bottleneck",
      detail: `${blockedDays} review-window days had add candidates but no safe drop candidates. That blocks roster-upgrade recommendations even when the model finds adds.`,
    });
  }
  const directNext = opportunityMatrix.filter((row) => row.versusNextTeamAbove).slice(0, 3);
  if (directNext.length > 0) {
    recs.push({
      priority: "medium",
      title: "Prioritize categories that hit the team directly above us",
      detail: `Best direct-gap categories: ${directNext.map((row) => row.key).join(", ")}.`,
    });
  }
  const top = opportunityMatrix.slice(0, 3);
  if (top.length > 0) {
    recs.push({
      priority: "medium",
      title: "Use opportunity matrix as a tie-breaker",
      detail: `Current top opportunity categories: ${top.map((row) => `${row.key} (${row.opportunityScore.toFixed(1)})`).join(", ")}.`,
    });
  }
  if (latestTransition?.gapClosed !== null && latestTransition.gapClosed < 0) {
    recs.push({
      priority: "medium",
      title: "Separate our gains from opponent movement",
      detail: `Latest gap worsened by ${signedText(-latestTransition.gapClosed)} even though our own point movement was ${signedText(latestTransition.myPointDelta)}; compare this to estimated next-team movement ${signedText(latestTransition.nextTeamPointDelta)}.`,
    });
  }
  const latestRiskStarts = (latestTransition?.startOutcome?.starts || []).filter(
    (start) => start.used && start.riskFlags.length > 0
  );
  if (latestRiskStarts.length > 0 && latestTransition?.startOutcome?.targetPointDelta <= 0) {
    recs.push({
      priority: "medium",
      title: "Tighten pitcher downside-risk gating",
      detail: `Used starts with ratio risk did not produce target-category points. Risk starts: ${latestRiskStarts.map((start) => start.playerName).join(", ")}.`,
    });
  }
  if (transitions.length > 0 && recs.length === 0) {
    recs.push({
      priority: "low",
      title: "Keep current champion but monitor multi-day outcomes",
      detail: "No dominant execution or roster-constraint blocker appeared in the current review window.",
    });
  }
  return recs;
}

function printRankReview(report) {
  if (!report.latest) {
    console.log("No snapshots found. Run recommend first.");
    return;
  }
  console.log(cYellow("Rank Attribution Review"));
  console.log(
    `Window ${report.window.from || "n/a"} -> ${report.window.to || "n/a"} | Rank ${report.latest.rank ?? "n/a"} | Points to next ${
      report.latest.pointsToNextTeam?.delta !== undefined ? `+${formatMaybeNumber(report.latest.pointsToNextTeam.delta, 1)}` : "n/a"
    }`
  );
  console.log("");

  console.log(cYellow("Why rank moved or stayed stuck:"));
  console.log(fmtBullet(`Gap closed over window: ${signedText(report.summary.totalGapClosed, 1)} points`));
  console.log(fmtBullet(`Our roto-point movement: ${signedText(report.summary.totalMyPointDelta, 1)}`));
  console.log(fmtBullet(`Estimated next-team movement: ${signedText(report.summary.totalNextTeamPointDelta, 1)}`));
  if (report.summary.adherenceRate !== null) {
    console.log(fmtBullet(`Average start adherence: ${(report.summary.adherenceRate * 100).toFixed(0)}%`));
  }
  console.log(fmtBullet(`Days blocked by add/drop safety: ${report.summary.blockedDays}/${report.summary.evaluatedDays}`));
  if (!report.summary.rankChanged) {
    console.log(fmtBullet("Overall rank did not change in this review window."));
  }
  console.log("");

  if (report.latestTransition) {
    const row = report.latestTransition;
    console.log(cYellow("Latest daily attribution:"));
    console.log(fmtBullet(`${row.fromDate} -> ${row.toDate}: rank ${row.rankBefore} -> ${row.rankAfter}, gap closed ${signedText(row.gapClosed, 1)}`));
    console.log(fmtBullet(`Targets ${row.targets.join(", ") || "none"} netted ${signedText(row.targetPointDelta, 1)} category points`));
    if (row.adherence && row.adherence.recommendedCount > 0) {
      console.log(fmtBullet(`Lineup adherence ${row.adherence.matched}/${row.adherence.recommendedCount}`));
    }
    if (row.startOutcome) {
      console.log(
        fmtBullet(
          `Start outcome target ${signedText(row.startOutcome.targetPointDelta, 1)}, non-target ${signedText(row.startOutcome.nonTargetPointDelta, 1)}, estimated next-team ${signedText(row.startOutcome.estimatedNextTeamPointDelta, 1)}`
        )
      );
      row.startOutcome.starts
        .filter((start) => start.riskFlags.length > 0)
        .slice(0, 3)
        .forEach((start) => {
          console.log(fmtBullet(`Start risk ${start.playerName}: ${start.riskFlags.join("; ")}`));
        });
    }
    if (row.drivers.length > 0) {
      row.drivers.forEach((driver) => console.log(fmtBullet(driver)));
    }
    console.log("");
  }

  console.log(cYellow("Multi-horizon outcomes:"));
  report.horizons.forEach((horizon) => {
    console.log(
      fmtBullet(
        `${horizon.days}d: gap closed avg ${signedText(horizon.meanGapClosed, 2)}, rank gain avg ${signedText(horizon.meanRankDelta, 2)}, target pts avg ${signedText(horizon.meanTargetPointDelta, 2)}, rank improve rate ${
          horizon.rankImproveRate === null ? "n/a" : `${(horizon.rankImproveRate * 100).toFixed(0)}%`
        }`
      )
    );
  });
  console.log("");

  console.log(cYellow("Opportunity matrix:"));
  report.opportunityMatrix.slice(0, 8).forEach((row) => {
    const direct = row.versusNextTeamAbove ? "direct next-team gap" : row.status || "no immediate gap";
    console.log(
      fmtBullet(
        `${row.key}: score ${row.opportunityScore.toFixed(1)}, points ${formatMaybeNumber(row.points, 1)}, rank ${formatMaybeNumber(row.rank, 0)}, next gain ${formatMaybeNumber(row.pointsGainToNext, 1)} (${direct})`
      )
    );
  });
  console.log("");

  console.log(cYellow("Recommended next actions:"));
  report.recommendations.forEach((rec) => {
    console.log(fmtBullet(`${rec.priority.toUpperCase()}: ${rec.title} - ${rec.detail}`));
  });
}

async function rankReview() {
  const days = Number(getArgValue("--days")) || 14;
  const snapshots = readJsonl(SNAPSHOT_LOG);
  const report = buildRankReview(snapshots, { days });
  const outPath = path.join(LOG_DIR, "rank-review.json");
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  printRankReview(report);
  console.log("");
  console.log(`Rank review JSON: ${outPath}`);
}

function isMeaningfulUpgrade(addRank, dropRank) {
  if (addRank === null || addRank === undefined) return false;
  if (dropRank === null || dropRank === undefined) return false;
  return dropRank - addRank >= ADD_RANK_IMPROVEMENT;
}

function computeStatScore(statsMap, statKeys, statIdByKey) {
  if (!statsMap || !(statsMap instanceof Map)) return null;
  if (!statKeys || statKeys.length === 0) return null;
  let score = 0;
  let hasStat = false;
  statKeys.forEach((key) => {
    const statId = statIdByKey.get(key);
    if (!statId) return;
    const value = statsMap.get(statId);
    if (value === null || value === undefined) return;
    hasStat = true;
    score += isLowerBetter(key, key) ? -value : value;
  });
  return hasStat ? score : null;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function normalizeLookupText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeMlbTeamAbbr(abbr) {
  const raw = String(abbr || "").trim().toUpperCase();
  const aliases = {
    ARI: "AZ",
    CWS: "CHW",
    KCR: "KC",
    SFG: "SF",
    TBR: "TB",
    WSH: "WSH",
    WAS: "WSH",
  };
  return aliases[raw] || raw;
}

function baseballInningsToDecimal(value) {
  const n = toNumber(value);
  if (n === null) return null;
  const whole = Math.trunc(n);
  const tenths = Math.round((n - whole) * 10);
  if (tenths <= 0) return whole;
  if (tenths === 1) return whole + 1 / 3;
  if (tenths === 2) return whole + 2 / 3;
  return n;
}

function statValueForKey(player, key, statIdByKey) {
  const fallbackStatIds = {
    IP: "50",
    W: "28",
    SV: "32",
    K: "42",
    ERA: "26",
    WHIP: "27",
    R: "7",
    HR: "12",
    RBI: "13",
    SB: "16",
    AVG: "3",
  };
  const statId = statIdByKey.get(key) || fallbackStatIds[key];
  if (!statId || !player?.stats || !(player.stats instanceof Map)) return null;
  return toNumber(player.stats.get(statId));
}

function formatStartScore(value) {
  const n = toNumber(value);
  if (n === null) return null;
  return n.toFixed(1);
}

async function fetchMlbScheduleContext({ startDate, endDate }) {
  const empty = {
    scheduleAvailable: false,
    dateRange: { startDate, endDate },
    teams: new Map(),
    probablePitchers: new Map(),
  };
  try {
    const params = new URLSearchParams({
      sportId: "1",
      startDate,
      endDate,
      hydrate: "probablePitcher,team,linescore",
    });
    const response = await fetch(`${MLB_STATS_API_BASE}/schedule?${params.toString()}`);
    if (!response.ok) return empty;
    const data = await response.json();
    const teams = new Map();
    const probablePitchers = new Map();
    (data.dates || []).forEach((dateRow) => {
      (dateRow.games || []).forEach((game) => {
        const officialDate = game.officialDate || dateRow.date || null;
        ["home", "away"].forEach((side) => {
          const otherSide = side === "home" ? "away" : "home";
          const entry = game.teams?.[side] || {};
          const oppEntry = game.teams?.[otherSide] || {};
          const team = entry.team || {};
          const opponent = oppEntry.team || {};
          const teamAbbr = normalizeMlbTeamAbbr(team.abbreviation || team.fileCode);
          if (!teamAbbr) return;
          const oppPct = toNumber(oppEntry.leagueRecord?.pct) ?? 0.5;
          const teamPct = toNumber(entry.leagueRecord?.pct) ?? 0.5;
          const probableName = entry.probablePitcher?.fullName || null;
          const teamGame = {
            date: officialDate,
            gameDate: game.gameDate || null,
            side,
            home: side === "home",
            opponentAbbr: normalizeMlbTeamAbbr(opponent.abbreviation || opponent.fileCode),
            opponentName: opponent.name || null,
            opponentPct: oppPct,
            teamPct,
            probablePitcherName: probableName,
            probablePitcherId: entry.probablePitcher?.id || null,
            status: game.status?.detailedState || game.status?.abstractGameState || null,
          };
          if (!teams.has(teamAbbr)) teams.set(teamAbbr, []);
          teams.get(teamAbbr).push(teamGame);
          if (probableName) {
            probablePitchers.set(
              `${teamAbbr}|${normalizeLookupText(probableName)}`,
              teamGame
            );
          }
        });
      });
    });
    return {
      scheduleAvailable: teams.size > 0,
      dateRange: { startDate, endDate },
      teams,
      probablePitchers,
    };
  } catch {
    return empty;
  }
}

function scheduleInfoForPlayer(player, scheduleContext) {
  const teamAbbr = normalizeMlbTeamAbbr(player?.teamAbbr);
  if (!teamAbbr || !scheduleContext?.teams) {
    return { teamAbbr, games: [], probableGame: null, nextGame: null };
  }
  const games = (scheduleContext.teams.get(teamAbbr) || []).slice().sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
  );
  const nameKey = `${teamAbbr}|${normalizeLookupText(player?.name)}`;
  const probableGame = scheduleContext.probablePitchers?.get(nameKey) || null;
  return { teamAbbr, games, probableGame, nextGame: games[0] || null };
}

function buildStartScore({ player, focusKeys, statIdByKey, scheduleContext }) {
  const focusSet = new Set(Array.isArray(focusKeys) ? focusKeys : []);
  const info = scheduleInfoForPlayer(player, scheduleContext);
  const isPitcher = !!player?.isPitcher;
  const isRpOnly =
    isPitcher &&
    Array.isArray(player.positions) &&
    player.positions.includes("RP") &&
    !player.positions.includes("SP");
  const probableGame = info.probableGame;
  const nextGame = info.nextGame;
  const hasGame = !!nextGame;
  const isProbable = !!probableGame;
  const game = probableGame || nextGame || null;
  const daysOut =
    game?.date && scheduleContext?.dateRange?.startDate
      ? daysBetweenUtc(parseIsoDate(scheduleContext.dateRange.startDate), parseIsoDate(game.date))
      : null;
  const teamPct = toNumber(game?.teamPct) ?? 0.5;
  const opponentPct = toNumber(game?.opponentPct) ?? 0.5;
  const winProxy = clampNumber(0.5 + (teamPct - opponentPct) * 0.6 + (game?.home ? 0.04 : 0), 0.2, 0.8);

  const ip = baseballInningsToDecimal(statValueForKey(player, "IP", statIdByKey));
  const k = statValueForKey(player, "K", statIdByKey) ?? 0;
  const era = statValueForKey(player, "ERA", statIdByKey);
  const whip = statValueForKey(player, "WHIP", statIdByKey);
  const kPerIp = ip && ip > 0 ? k / ip : 0;
  const projectedIp = isProbable ? 5.2 : isPitcher && hasGame ? (isRpOnly ? 1 : 1.5) : 0;
  const projectedK = projectedIp * kPerIp;
  const reasons = [];
  let score = 0;

  if (isPitcher) {
    if (isProbable) {
      score += daysOut === 0 ? 30 : 22;
      reasons.push(`probable starter ${game.date}`);
    } else if (hasGame && isRpOnly) {
      score += daysOut === 0 ? 8 : 5;
      reasons.push(`reliever has ${game.date} game`);
    } else if (hasGame) {
      score += 2;
      reasons.push(`team has ${game.date} game but not listed probable`);
    } else {
      score -= 8;
      reasons.push("no scheduled game found");
    }

    if (focusSet.has("K")) {
      score += projectedK * 1.5;
      reasons.push(`projected K ${projectedK.toFixed(1)}`);
    }
    if (focusSet.has("W")) {
      const winScore = (isProbable ? 8 : 2) * winProxy;
      score += winScore;
      reasons.push(`win proxy ${(winProxy * 100).toFixed(0)}%`);
    }
    if (focusSet.has("ERA") || focusSet.has("WHIP")) {
      if (era !== null) score += era <= 3.5 ? 3 : era >= 4.8 ? -4 : 0;
      if (whip !== null) score += whip <= 1.15 ? 3 : whip >= 1.35 ? -4 : 0;
    } else {
      if (era !== null && era >= 5) score -= 3;
      if (whip !== null && whip >= 1.4) score -= 3;
    }
    const downside = startRiskAssessment({ schedule: { era, whip, projectedIp }, focusKeys });
    if (downside.penalty > 0) {
      score -= downside.penalty;
      reasons.push(`downside risk gate -${downside.penalty}: ${downside.flags.join("; ")}`);
    }
    score += (0.5 - opponentPct) * 4;
    reasons.push(`opponent ${game?.opponentAbbr || "unknown"} pct ${opponentPct.toFixed(3)}`);
    if (era !== null || whip !== null) {
      reasons.push(`risk ERA ${era ?? "n/a"}, WHIP ${whip ?? "n/a"}`);
    }
  } else {
    if (hasGame) {
      score += daysOut === 0 ? 8 : 5;
      reasons.push(`team has ${game.date} game`);
    } else {
      score -= 6;
      reasons.push("no scheduled game found");
    }
    const statScore = computeStatScore(player.stats, [...focusSet], statIdByKey);
    if (statScore !== null) {
      score += statScore * 0.1;
      reasons.push(`target stat score ${statScore.toFixed(1)}`);
    }
  }

  const rank = player.rank === null || player.rank === undefined ? null : Number(player.rank);
  if (rank !== null && Number.isFinite(rank)) {
    score += Math.max(0, (250 - rank) / 100);
  }

  return {
    score,
    reasons,
    schedule: {
      teamAbbr: info.teamAbbr || null,
      opponentAbbr: game?.opponentAbbr || null,
      opponentName: game?.opponentName || null,
      date: game?.date || null,
      probable: isProbable,
      winProxy,
      projectedIp,
      projectedK,
      era,
      whip,
    },
  };
}

function rankStartCandidates({ candidates, focusKeys, statIdByKey, scheduleContext }) {
  return (candidates || [])
    .map((player) => {
      const startModel = buildStartScore({ player, focusKeys, statIdByKey, scheduleContext });
      return {
        ...player,
        startScore: startModel.score,
        startReasons: startModel.reasons,
        startSchedule: startModel.schedule,
      };
    })
    .sort((a, b) => {
      if ((b.startScore ?? 0) !== (a.startScore ?? 0)) {
        return (b.startScore ?? 0) - (a.startScore ?? 0);
      }
      if (a.rank === null && b.rank === null) return 0;
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    });
}

function safeMeanStd(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return { mean: 0, std: 1 };
  const mean = clean.reduce((s, v) => s + v, 0) / clean.length;
  const variance =
    clean.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / clean.length;
  const std = Math.sqrt(variance) || 1;
  return { mean, std };
}

function isRateStat(statKey) {
  return ["AVG", "ERA", "WHIP"].includes(statKey);
}

function expectedRate({
  statKey,
  statId,
  isPitcher,
  currentStats,
  historySeasonStats,
  sampleStatId,
}) {
  const currentValueRaw = currentStats?.get(statId);
  const currentValue = toNumber(currentValueRaw);
  const currentSample = sampleStatId ? toNumber(currentStats?.get(sampleStatId)) : null;

  const historyEntries = [];
  if (historySeasonStats && historySeasonStats instanceof Map) {
    historySeasonStats.forEach((seasonStats) => {
      if (!(seasonStats instanceof Map)) return;
      const value = toNumber(seasonStats.get(statId));
      if (value === null) return;
      let sample = null;
      if (!isRateStat(statKey) && sampleStatId) {
        sample = toNumber(seasonStats.get(sampleStatId));
      }
      historyEntries.push({ value, sample });
    });
  }

  // Prior: weighted by AB/IP for counting stats; simple average for rate stats.
  let prior = null;
  let priorSampleTotal = 0;
  if (historyEntries.length > 0) {
    if (isRateStat(statKey)) {
      const vals = historyEntries.map((e) => e.value);
      prior = vals.reduce((s, v) => s + v, 0) / vals.length;
    } else {
      if (!sampleStatId) {
        const vals = historyEntries.map((e) => e.value);
        prior = vals.reduce((s, v) => s + v, 0) / vals.length;
      } else {
      let weightedSum = 0;
      let weightTotal = 0;
      historyEntries.forEach((e) => {
        const w = Number.isFinite(e.sample) && e.sample > 0 ? e.sample : 0;
        if (w <= 0) return;
        weightedSum += (e.value / w) * w;
        weightTotal += w;
      });
      if (weightTotal > 0) {
        prior = weightedSum / weightTotal;
        priorSampleTotal = weightTotal;
      }
      }
    }
  }

  if (currentValue === null && prior === null) return null;

  // Current: convert counting stats to per-sample rate.
  let currentRate = null;
  if (currentValue !== null) {
    if (isRateStat(statKey)) {
      currentRate = currentValue;
    } else if (!sampleStatId) {
      currentRate = currentValue;
    } else if (currentSample !== null && currentSample > 0) {
      currentRate = currentValue / currentSample;
    }
  }

  if (prior === null) return currentRate;
  if (currentRate === null) return prior;

  const stabilizer = isPitcher ? PITCHER_STABILIZER_IP : HITTER_STABILIZER_AB;
  const sample = currentSample !== null && currentSample > 0 ? currentSample : 0;
  const w = sampleStatId ? sample / (sample + stabilizer) : 0.5;
  return w * currentRate + (1 - w) * prior;
}

function computeProjectedZScore({
  playerKey,
  isPitcher,
  statKeys,
  statIdByKey,
  currentSeasonStatsByKey,
  historyByKey,
  abStatId,
  ipStatId,
  zContext,
}) {
  if (!playerKey) return null;
  const currentStats = currentSeasonStatsByKey.get(playerKey) || null;
  const historySeasonStats = historyByKey.get(playerKey) || null;
  const sampleStatId = isPitcher ? ipStatId : abStatId;
  let score = 0;
  let hasAny = false;
  statKeys.forEach((key) => {
    const statId = statIdByKey.get(key);
    if (!statId) return;
    const val = expectedRate({
      statKey: key,
      statId,
      isPitcher,
      currentStats,
      historySeasonStats,
      sampleStatId,
    });
    if (val === null || val === undefined) return;
    hasAny = true;
    const ctx = zContext.get(key);
    if (!ctx) return;
    let z = (val - ctx.mean) / (ctx.std || 1);
    if (isLowerBetter(key, key)) z = -z;
    const weight = ctx.weight || 1;
    score += weight * z;
  });
  return hasAny ? score : null;
}

function rankHittersByStats(candidates, statIdByKey, targetKeys) {
  const statKeys = ["R", "HR", "RBI", "SB", "AVG"];
  const weights = {};
  statKeys.forEach((key) => {
    weights[key] = targetKeys.includes(key) ? 1.5 : 1;
  });
  const valuesByKey = {};
  statKeys.forEach((key) => {
    const statId = statIdByKey.get(key);
    valuesByKey[key] = candidates.map((candidate) => {
      if (!statId) return 0;
      return candidate.stats?.get(statId) ?? 0;
    });
  });
  const mean = (arr) => arr.reduce((sum, v) => sum + v, 0) / (arr.length || 1);
  const std = (arr, m) => {
    const variance =
      arr.reduce((sum, v) => sum + Math.pow(v - m, 2), 0) / (arr.length || 1);
    return Math.sqrt(variance) || 1;
  };
  const zStats = {};
  statKeys.forEach((key) => {
    const vals = valuesByKey[key];
    const m = mean(vals);
    const s = std(vals, m);
    zStats[key] = { m, s };
  });

  return candidates
    .map((candidate) => {
      let score = 0;
      statKeys.forEach((key) => {
        const statId = statIdByKey.get(key);
        const raw = statId ? candidate.stats?.get(statId) ?? 0 : 0;
        const z = (raw - zStats[key].m) / zStats[key].s;
        score += z * weights[key];
      });
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score);
}

function zscoreMatrix(X) {
  const n = X.length;
  const p = X[0]?.length || 0;
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

function dist2Vec(a, b) {
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

function kmeansSimple(Z, k, { nInit = 15, maxIter = 60, seed = 42 } = {}) {
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
      for (let i = 0; i < n; i += 1) {
        let bestJ = 0;
        let bestD = Infinity;
        for (let j = 0; j < k; j += 1) {
          const d = dist2Vec(Z[i], centers[j]);
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

    let inertia = 0;
    for (let i = 0; i < n; i += 1) inertia += dist2Vec(Z[i], centers[labels[i]]);
    if (!best || inertia < best.inertia) best = { labels, centers, inertia };
  }

  return best;
}

function buildPlayerFeatureVector({
  playerKey,
  isPitcher,
  statKeys,
  statIdByKey,
  seasonStats,
  lastMonthStats,
  abStatId,
  ipStatId,
}) {
  if (!playerKey) return null;
  const sampleStatId = isPitcher ? ipStatId : abStatId;
  const seasonSample = sampleStatId ? toNumber(seasonStats?.get(sampleStatId)) : null;
  const lastSample = sampleStatId ? toNumber(lastMonthStats?.get(sampleStatId)) : null;

  const vec = [];
  statKeys.forEach((key) => {
    const statId = statIdByKey.get(key);
    const raw = statId ? toNumber(seasonStats?.get(statId)) : null;
    if (isRateStat(key)) {
      vec.push(raw ?? 0);
    } else {
      const denom = seasonSample !== null && seasonSample > 0 ? seasonSample : null;
      vec.push(raw !== null && denom ? raw / denom : 0);
    }
  });
  statKeys.forEach((key) => {
    const statId = statIdByKey.get(key);
    const raw = statId ? toNumber(lastMonthStats?.get(statId)) : null;
    if (isRateStat(key)) {
      vec.push(raw ?? 0);
    } else {
      const denom = lastSample !== null && lastSample > 0 ? lastSample : null;
      vec.push(raw !== null && denom ? raw / denom : 0);
    }
  });

  const stabilizer = isPitcher ? PITCHER_STABILIZER_IP : HITTER_STABILIZER_AB;
  const s = seasonSample !== null && seasonSample > 0 ? seasonSample : 0;
  const lm = lastSample !== null && lastSample > 0 ? lastSample : 0;
  vec.push(stabilizer > 0 ? s / (s + stabilizer) : 0);
  vec.push(stabilizer > 0 ? lm / (lm + stabilizer) : 0);

  return vec;
}

function labelArchetype({ isPitcher, topKeys }) {
  const keys = topKeys || [];
  if (isPitcher) {
    if (keys.includes("SV")) return "Closer";
    if (keys.includes("K") && (keys.includes("ERA") || keys.includes("WHIP"))) return "K/Ratio";
    if (keys.includes("K")) return "Strikeouts";
    if (keys.includes("W")) return "Wins";
    return "Arms";
  }
  if (keys.includes("SB")) return "Speed";
  if (keys.includes("HR") || keys.includes("RBI")) return "Power";
  if (keys.includes("AVG")) return "Average";
  if (keys.includes("R")) return "Runs";
  return "Balanced";
}

function buildArchetypes({
  poolPlayers,
  isPitcher,
  statKeys,
  statIdByKey,
  seasonStatsByKey,
  lastMonthStatsByKey,
  abStatId,
  ipStatId,
  focusKeys,
}) {
  const rows = [];
  const keys = [];
  for (const pk of poolPlayers) {
    const seasonStats = seasonStatsByKey.get(pk) || null;
    if (!seasonStats) continue;
    const lastMonthStats = lastMonthStatsByKey.get(pk) || new Map();
    const v = buildPlayerFeatureVector({
      playerKey: pk,
      isPitcher,
      statKeys,
      statIdByKey,
      seasonStats,
      lastMonthStats,
      abStatId,
      ipStatId,
    });
    if (!v) continue;
    rows.push(v);
    keys.push(pk);
  }

  if (rows.length < 6) return new Map();
  const { Z } = zscoreMatrix(rows);
  const n = Z.length;
  const k = Math.max(2, Math.min(4, Math.round(Math.sqrt(n))));
  const km = kmeansSimple(Z, Math.min(k, n), { seed: 1337 });
  if (!km) return new Map();

  const p = Z[0].length;
  const centroids = Array.from({ length: km.centers.length }, () =>
    Array.from({ length: p }, () => 0)
  );
  const counts = Array.from({ length: km.centers.length }, () => 0);
  for (let i = 0; i < n; i += 1) {
    const c = km.labels[i];
    counts[c] += 1;
    for (let j = 0; j < p; j += 1) centroids[c][j] += Z[i][j];
  }
  for (let c = 0; c < centroids.length; c += 1) {
    const denom = counts[c] || 1;
    for (let j = 0; j < p; j += 1) centroids[c][j] /= denom;
  }

  const featureIndex = new Map();
  statKeys.forEach((key, idx) => {
    featureIndex.set(key, { season: idx, lastMonth: idx + statKeys.length });
  });
  const goodnessByCluster = new Map();
  for (let c = 0; c < centroids.length; c += 1) {
    const centroid = centroids[c];
    const goodness = {};
    statKeys.forEach((key) => {
      const idxs = featureIndex.get(key);
      const raw = ((centroid[idxs.season] ?? 0) + (centroid[idxs.lastMonth] ?? 0)) / 2;
      // For lower-better stats, a more negative z is better.
      goodness[key] = isLowerBetter(key, key) ? -raw : raw;
    });
    goodnessByCluster.set(c, goodness);
  }

  const focusSet = new Set(
    (focusKeys || []).filter((k2) => statKeys.includes(k2))
  );
  const out = new Map();

  for (let i = 0; i < keys.length; i += 1) {
    const pk = keys[i];
    const cluster = km.labels[i];
    const goodness = goodnessByCluster.get(cluster) || {};
    const sortedKeys = [...statKeys]
      .map((k2) => ({ key: k2, score: goodness[k2] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((x) => x.key);
    const label = labelArchetype({ isPitcher, topKeys: sortedKeys });
    let fitScore = 0;
    if (focusSet.size > 0) {
      focusSet.forEach((k2) => {
        fitScore += goodness[k2] ?? 0;
      });
    } else {
      sortedKeys.forEach((k2) => {
        fitScore += goodness[k2] ?? 0;
      });
    }
    out.set(pk, { cluster, label, fitScore });
  }

  return out;
}

function buildEfficiencyScores(resolvedCategories, teamMetrics, myTeamMetrics, teamKey) {
  const scores = new Map();
  if (!teamMetrics || teamMetrics.length === 0 || !myTeamMetrics) return scores;
  resolvedCategories.forEach((cat) => {
    if (!cat.statId) return;
    const isLower = isLowerBetter(cat.key, cat.name);
    const myStat = myTeamMetrics.statsById.get(cat.statId);
    const myValue = toNumber(extractStatValue(myStat));
    const myPoints = toNumber(
      extractStatValue(myTeamMetrics.pointsById.get(cat.statId))
    );
    if (myValue === null) return;

    const entries = teamMetrics
      .map((team) => {
        const stat = team.statsById.get(cat.statId);
        const value = toNumber(extractStatValue(stat));
        const points = toNumber(
          extractStatValue(team.pointsById.get(cat.statId))
        );
        return { teamKey: team.teamKey, value, points };
      })
      .filter((entry) => entry.value !== null);

    const sorted = entries.sort((a, b) =>
      isLower ? a.value - b.value : b.value - a.value
    );
    const myIndex = sorted.findIndex((entry) => entry.teamKey === teamKey);
    if (myIndex === -1) return;

    const mySortedValue = sorted[myIndex].value;
    let groupStart = myIndex;
    while (groupStart > 0 && sorted[groupStart - 1].value === mySortedValue) {
      groupStart -= 1;
    }
    if (groupStart === 0) return;

    const nextBetter = sorted[groupStart - 1];
    const targetValue = nextBetter.value;
    const delta = isLower ? mySortedValue - targetValue : targetValue - mySortedValue;
    const pointsGain =
      myPoints !== null && nextBetter.points !== null
        ? nextBetter.points - myPoints
        : null;
    const efficiency = efficiencyValue(cat.key, delta, pointsGain);
    if (efficiency !== null && pointsGain !== null) {
      scores.set(cat.key, efficiency);
    }
  });
  return scores;
}

function buildPointGapScores(resolvedCategories, teamMetrics, myTeamMetrics, teamKey) {
  const scores = new Map();
  if (!teamMetrics || teamMetrics.length === 0 || !myTeamMetrics) return scores;
  const deltas = [];

  resolvedCategories.forEach((cat) => {
    if (!cat.statId) return;
    const isLower = isLowerBetter(cat.key, cat.name);
    const myStat = myTeamMetrics.statsById.get(cat.statId);
    const myValue = toNumber(extractStatValue(myStat));
    if (myValue === null) return;

    const entries = teamMetrics
      .map((team) => {
        const stat = team.statsById.get(cat.statId);
        const value = toNumber(extractStatValue(stat));
        return { teamKey: team.teamKey, value };
      })
      .filter((entry) => entry.value !== null);

    const sorted = entries.sort((a, b) =>
      isLower ? a.value - b.value : b.value - a.value
    );
    const myIndex = sorted.findIndex((entry) => entry.teamKey === teamKey);
    if (myIndex === -1) return;

    const mySortedValue = sorted[myIndex].value;
    let groupStart = myIndex;
    while (groupStart > 0 && sorted[groupStart - 1].value === mySortedValue) {
      groupStart -= 1;
    }
    if (groupStart === 0) return;

    const nextBetter = sorted[groupStart - 1];
    const targetValue = nextBetter.value;
    const delta = isLower ? mySortedValue - targetValue : targetValue - mySortedValue;
    const absDelta = Math.abs(delta);
    if (absDelta === 0) return;
    const units = absDelta / statUnitScale(cat.key);
    if (!Number.isFinite(units) || units <= 0) return;
    deltas.push({ key: cat.key, units });
  });

  if (deltas.length === 0) return scores;
  const maxUnits = Math.max(...deltas.map((entry) => entry.units));
  const minUnits = Math.min(...deltas.map((entry) => entry.units));
  deltas.forEach((entry) => {
    const normalized =
      maxUnits === minUnits ? 1 : (maxUnits - entry.units) / (maxUnits - minUnits);
    scores.set(entry.key, normalized);
  });
  return scores;
}

function buildCategoryNextGaps(resolvedCategories, teamMetrics, myTeamMetrics, teamKey) {
  const gaps = {};
  if (!teamMetrics || teamMetrics.length === 0 || !myTeamMetrics) return gaps;

  resolvedCategories.forEach((cat) => {
    if (!cat.statId) return;
    const isLower = isLowerBetter(cat.key, cat.name);
    const myStat = myTeamMetrics.statsById.get(cat.statId);
    const myValue = toNumber(extractStatValue(myStat));
    const myPoints = toNumber(
      extractStatValue(myTeamMetrics.pointsById.get(cat.statId))
    );
    if (myValue === null) return;

    const entries = teamMetrics
      .map((team) => {
        const stat = team.statsById.get(cat.statId);
        const value = toNumber(extractStatValue(stat));
        const points = toNumber(
          extractStatValue(team.pointsById.get(cat.statId))
        );
        return { teamKey: team.teamKey, teamName: team.teamName, value, points };
      })
      .filter((entry) => entry.value !== null);

    const sorted = entries.sort((a, b) =>
      isLower ? a.value - b.value : b.value - a.value
    );
    const myIndex = sorted.findIndex((entry) => entry.teamKey === teamKey);
    if (myIndex === -1) return;

    const mySortedValue = sorted[myIndex].value;
    let groupStart = myIndex;
    while (groupStart > 0 && sorted[groupStart - 1].value === mySortedValue) {
      groupStart -= 1;
    }

    if (groupStart === 0) {
      gaps[cat.key] = {
        direction: isLower ? "lower_is_better" : "higher_is_better",
        myValue: mySortedValue,
        myPoints,
        nextTeamKey: null,
        nextTeamName: null,
        nextValue: null,
        nextPoints: null,
        deltaToNext: null,
        pointsGainToNext: null,
        status: "leading",
      };
      return;
    }

    const nextBetter = sorted[groupStart - 1];
    const targetValue = nextBetter.value;
    const delta = isLower ? mySortedValue - targetValue : targetValue - mySortedValue;
    const pointsGain =
      myPoints !== null && nextBetter.points !== null
        ? nextBetter.points - myPoints
        : null;

    gaps[cat.key] = {
      direction: isLower ? "lower_is_better" : "higher_is_better",
      myValue: mySortedValue,
      myPoints,
      nextTeamKey: nextBetter.teamKey || null,
      nextTeamName: nextBetter.teamName || null,
      nextValue: targetValue,
      nextPoints: nextBetter.points ?? null,
      deltaToNext: delta,
      pointsGainToNext: pointsGain,
      status: "chasing",
    };
  });

  return gaps;
}

function buildStaleRecommendations(snapshots) {
  if (!snapshots || snapshots.length < 2) return new Set();
  const latest = snapshots[snapshots.length - 1];
  const previous = snapshots[snapshots.length - 2];
  if (!latest || !previous) return new Set();
  if (targetsImproved(previous, latest)) return new Set();

  const stale = new Set();
  const actions = latest.actions || {};
  ["addBatting", "addPitching", "add", "start", "drop"].forEach((key) => {
    const list = actions[key] || [];
    list.forEach((name) => stale.add(name));
  });
  return stale;
}

function applyStalePenalty(candidates, staleSet) {
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates;
  if (!staleSet || staleSet.size === 0) return candidates;
  const fresh = candidates.filter((item) => !staleSet.has(item.name));
  const stale = candidates.filter((item) => staleSet.has(item.name));
  return fresh.length > 0 ? [...fresh, ...stale] : candidates;
}

function formatPoints(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return Number.isInteger(num) ? `${num}` : num.toFixed(1);
}

function isLowerBetter(statKey, statName) {
  const key = (statKey || "").toString().toUpperCase();
  if (key === "ERA" || key === "WHIP") return true;
  const name = (statName || "").toString().toLowerCase();
  return name.includes("earned run average") || name.includes("whip");
}

function efficiencyLabel(statKey) {
  const key = (statKey || "").toString().toUpperCase();
  if (key === "AVG") return "pts per 0.001 AVG";
  if (key === "ERA" || key === "WHIP") return "pts per 0.01";
  return "pts per 1";
}

function statUnitScale(statKey) {
  const key = (statKey || "").toString().toUpperCase();
  if (key === "AVG") return 0.001;
  if (key === "ERA" || key === "WHIP") return 0.01;
  return 1;
}

function efficiencyValue(statKey, delta, pointsGain) {
  if (delta === null || delta === undefined) return null;
  if (pointsGain === null || pointsGain === undefined) return null;
  const absDelta = Math.abs(delta);
  if (absDelta === 0) return null;
  const scale = statUnitScale(statKey);
  const units = absDelta / scale;
  if (units === 0) return null;
  return pointsGain / units;
}

function formatEfficiency(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return num.toFixed(2);
}

function dropConfidenceTag(statType, index, total, hasStats) {
  if (!hasStats) return "LOW";
  let score = 1;
  if (statType === "lastmonth" || statType === "lastweek") score = 2;
  if (index < Math.max(1, Math.floor(total / 3))) score += 1;
  if (score >= 3) return "HIGH";
  if (score === 2) return "MED";
  return "LOW";
}

function applyLearningBoosts(rankedCategories, learning, efficiencyScores, pointGapScores) {
  const boosts = learning?.categoryBoost || {};
  const maxEfficiency =
    efficiencyScores && efficiencyScores.size > 0
      ? Math.max(...efficiencyScores.values())
      : 0;
  const maxGapScore =
    pointGapScores && pointGapScores.size > 0
      ? Math.max(...pointGapScores.values())
      : 0;
  return rankedCategories
    .map((cat) => {
      const efficiency = efficiencyScores?.get(cat.key) || 0;
      const efficiencyScore =
        maxEfficiency > 0 ? (efficiency / maxEfficiency) * 2 : 0;
      const gapScore =
        maxGapScore > 0 ? (pointGapScores?.get(cat.key) || 0) * 2 : 0;
      return {
        ...cat,
        priorityScore:
          (cat.rank ?? 0) + (boosts[cat.key] || 0) + efficiencyScore + gapScore,
        boost: boosts[cat.key] || 0,
        efficiencyScore,
        gapScore,
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

function opportunityScoreForCategory(cat, categoryNextGaps, pointsToNextTeam) {
  const gap = categoryNextGaps?.[cat.key] || {};
  const points = toNumber(cat.points) ?? 0;
  const pointsGainToNext = toNumber(gap.pointsGainToNext) ?? 0;
  const deltaToNext = toNumber(gap.deltaToNext);
  let score = 0;
  if (points <= 3) score += 4;
  else if (points <= 5) score += 2;
  if (String(gap.status || "") === "chasing" && pointsGainToNext > 0) {
    score += Math.min(4, pointsGainToNext);
  }
  if (
    pointsToNextTeam?.nextTeamKey &&
    gap.nextTeamKey &&
    pointsToNextTeam.nextTeamKey === gap.nextTeamKey
  ) {
    score += 3;
  }
  if (deltaToNext !== null) {
    score += Math.max(0, 2 - Math.min(2, Math.abs(deltaToNext) / Math.max(1, statUnitScale(cat.key))));
  }
  return score;
}

function rankOpportunityCategories(resolvedCategories, categoryNextGaps, pointsToNextTeam) {
  return (resolvedCategories || [])
    .filter((cat) => cat.rank !== null && !Number.isNaN(cat.rank))
    .map((cat) => ({
      ...cat,
      opportunityScore: opportunityScoreForCategory(cat, categoryNextGaps, pointsToNextTeam),
    }))
    .sort((a, b) => b.opportunityScore - a.opportunityScore || (a.points ?? 99) - (b.points ?? 99));
}

function extractTeamKey(teamNode) {
  const key =
    findFirstValueByKey(teamNode, "team_key") ??
    findFirstValueByKey(teamNode?.[0], "team_key");
  return key || null;
}

function extractTeamName(teamNode) {
  if (Array.isArray(teamNode) && Array.isArray(teamNode[0])) {
    const infoList = teamNode[0];
    const nameEntry = infoList.find(
      (item) => item && typeof item === "object" && "name" in item
    );
    if (nameEntry?.name) return nameEntry.name;
  }
  const name = findFirstValueByKey(teamNode, "name");
  return typeof name === "string" ? name : "Unknown Team";
}

function buildTeamMetrics(standings) {
  const teamNodes = findAllValuesByKey(standings, "team");
  const teams = [];
  teamNodes.forEach((teamNode) => {
    const teamKey = extractTeamKey(teamNode);
    if (!teamKey) return;
    const teamName = extractTeamName(teamNode);
    const teamStatsContainer = findFirstValueByKey(teamNode, "team_stats");
    const teamStatsEntries = extractStatEntries(
      teamStatsContainer?.stats ?? teamStatsContainer
    ).filter((stat) => extractStatId(stat));
    const statsById = new Map(
      teamStatsEntries.map((stat) => [extractStatId(stat), stat])
    );
    const teamPointsContainer = findFirstValueByKey(teamNode, "team_points");
    const teamPointsEntries = extractStatEntries(
      teamPointsContainer?.stats ?? teamPointsContainer
    ).filter((stat) => extractStatId(stat));
    const pointsById = new Map(
      teamPointsEntries.map((stat) => [extractStatId(stat), stat])
    );
    teams.push({ teamKey, teamName, statsById, pointsById });
  });
  return teams;
}

function computeTotalPoints(teamMetrics, statIds) {
  const totals = new Map();
  teamMetrics.forEach((team) => {
    let total = 0;
    let hasPoints = false;
    statIds.forEach((statId) => {
      const stat = team.pointsById.get(statId);
      const points = toNumber(extractStatValue(stat));
      if (points !== null) {
        total += points;
        hasPoints = true;
      }
    });
    totals.set(team.teamKey, hasPoints ? total : null);
  });
  return totals;
}

function daysBetweenUtc(startDate, endDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const start = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate()
  );
  const end = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate()
  );
  return Math.floor((end - start) / msPerDay);
}

function parseIsoDate(dateString) {
  if (!dateString) return null;
  const [year, month, day] = dateString.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function parseTokenResponse(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    const params = new URLSearchParams(bodyText);
    if ([...params.keys()].length === 0) {
      throw new Error(`Expected JSON but got: ${bodyText.slice(0, 200)}`);
    }
    return Object.fromEntries(params.entries());
  }
}

function normalizeScope(scope) {
  if (Array.isArray(scope)) return scope.join(" ");
  if (!scope) return "";
  return scope.toString().replace(/,/g, " ").trim();
}

function getOAuthScope(config) {
  const rawScope =
    config.oauthScope || process.env.YAHOO_OAUTH_SCOPE || "fspt-r";
  return normalizeScope(rawScope);
}

function getRedirectUri(config) {
  const rawRedirect =
    config.redirectUri || process.env.YAHOO_REDIRECT_URI || "oob";
  return rawRedirect.toString().trim();
}

function buildAuthUrl(config) {
  const scope = getOAuthScope(config);
  const redirectUri = getRedirectUri(config);
  if (!scope) {
    throw new Error(
      "Missing OAuth scope. Set oauthScope in config.json or YAHOO_OAUTH_SCOPE."
    );
  }
  if (!redirectUri) {
    throw new Error(
      "Missing redirectUri. Set redirectUri in config.json or YAHOO_REDIRECT_URI."
    );
  }
  const params = new URLSearchParams({
    client_id: config.consumerKey,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
  });
  return `${AUTH_AUTHORIZE_URL}?${params.toString()}`;
}

async function getAccessToken(config) {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error("Missing tokens. Run: node fantasy/cli.js auth");
  }
  if (!tokens.access_token) {
    throw new Error("Missing access_token. Run: node fantasy/cli.js auth");
  }
  if (isTokenExpired(tokens)) {
    if (!tokens.refresh_token) {
      throw new Error("Token expired and missing refresh_token. Run auth again.");
    }
    const refreshed = await refreshTokens({
      consumerKey: config.consumerKey,
      consumerSecret: config.consumerSecret,
      refreshToken: tokens.refresh_token,
    });
    saveTokens(refreshed);
    return refreshed.access_token;
  }
  return tokens.access_token;
}

async function auth() {
  const config = loadConfig();
  if (!config.consumerKey || !config.consumerSecret) {
    throw new Error("consumerKey/consumerSecret missing in fantasy/config.json");
  }

  const authUrl = buildAuthUrl(config);
  const redirectUri = getRedirectUri(config);
  debugLog("Authorization URL", { url: authUrl });

  console.log("Open this URL in your browser to authorize:");
  console.log(authUrl);
  const code = await prompt("Paste the code parameter here: ");

  const basic = Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`
  ).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });

  debugLog("Requesting access token", { url: AUTH_TOKEN_URL });
  const accessTokenResponse = await fetch(AUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const accessTokenBody = await accessTokenResponse.text();
  if (!accessTokenResponse.ok) {
    debugLog("Access token response body", accessTokenBody);
    throw new Error(`Access token failed: ${accessTokenBody}`);
  }

  const accessTokenData = parseTokenResponse(accessTokenBody);
  const issuedAt = Date.now();
  const expiresIn = Number(accessTokenData.expires_in) || null;
  const expiresAt = expiresIn ? issuedAt + expiresIn * 1000 : null;
  saveTokens({
    ...accessTokenData,
    issued_at: issuedAt,
    expires_at: expiresAt,
  });

  console.log("Access token saved to fantasy/.tokens.json");
}

async function check() {
  const config = loadConfig();
  const authUrl = buildAuthUrl(config);
  const redirectUri = getRedirectUri(config);
  const scope = getOAuthScope(config);

  console.log("Connectivity check");
  console.log(`Authorization URL: ${AUTH_AUTHORIZE_URL}`);
  console.log(`Redirect URI: ${redirectUri}`);
  console.log(`Scope: ${scope}`);

  try {
    const unauthResponse = await fetch(authUrl, { redirect: "manual" });
    const unauthBody = await unauthResponse.text();
    console.log(
      `Unauthenticated status: ${unauthResponse.status} ${unauthResponse.statusText}`
    );
    const location = unauthResponse.headers.get("location");
    if (location) {
      console.log(`Unauthenticated redirect: ${location}`);
    } else {
      console.log(`Unauthenticated body: ${unauthBody.slice(0, 200)}`);
    }
  } catch (error) {
    console.log(`Unauthenticated request failed: ${error.message}`);
  }
}

async function discover() {
  const config = loadConfig();
  const accessToken = await getAccessToken(config);

  const gameKey = config.gameKey || "mlb";
  const url = `${FANTASY_API_BASE}/users;use_login=1/games;game_keys=${gameKey}/leagues/teams?format=json`;
  const data = await yahooRequest({
    url,
    accessToken,
  });
  writeDebugJson("discover", data);

  const leagueKeys = [...new Set(findAllValuesByKey(data, "league_key"))];
  const teamKeys = [...new Set(findAllValuesByKey(data, "team_key"))];

  if (leagueKeys.length === 0 || teamKeys.length === 0) {
    throw new Error("Could not find league_key or team_key in response.");
  }

  console.log("Found leagues:");
  leagueKeys.forEach((key) => console.log(`- ${key}`));
  console.log("Found teams:");
  teamKeys.forEach((key) => console.log(`- ${key}`));

  config.leagueKey = leagueKeys[0];
  config.teamKey = teamKeys[0];
  saveConfig(config);

  console.log("Saved leagueKey and teamKey to fantasy/config.json");
}

async function recommend({ snapshotOnly = false } = {}) {
  if (!snapshotOnly) {
    await refreshBenchmarkIfStaleForRecommend();
  }
  const config = loadConfig();
  const leagueSettingsFile = loadLeagueSettingsFile();
  const accessToken = await getAccessToken(config);
  const positionFilter = getPositionFilter();
  if (!config.leagueKey || !config.teamKey) {
    throw new Error("Missing leagueKey/teamKey. Run: node fantasy/cli.js discover");
  }

  const leagueSettings = await yahooRequest({
    url: `${FANTASY_API_BASE}/league/${config.leagueKey}/settings?format=json`,
    accessToken,
  });
  writeDebugJson("league-settings", leagueSettings);

  const standings = await yahooRequest({
    url: `${FANTASY_API_BASE}/league/${config.leagueKey}/standings?format=json`,
    accessToken,
  });
  writeDebugJson("standings", standings);

  const teamData = findTeamByKey(standings, config.teamKey);
  if (!teamData) {
    throw new Error("Could not find your team in standings response.");
  }
  writeDebugJson("team-data", teamData);

  const statNameMap = new Map();
  const statEntries = findAllValuesByKey(leagueSettings, "stat");
  statEntries.forEach((entry) => {
    const statId = extractStatId(entry);
    const name = extractStatName(entry);
    if (statId && name) {
      statNameMap.set(statId.toString(), name);
    }
  });

  const teamStatsContainer = findFirstValueByKey(teamData, "team_stats");
  const teamStatsEntries = extractStatEntries(
    teamStatsContainer?.stats ?? teamStatsContainer
  ).filter((stat) => extractStatId(stat));
  const teamStatsById = new Map(
    teamStatsEntries.map((stat) => [extractStatId(stat), stat])
  );

  const teamKeysInStandings = [
    ...new Set(findAllValuesByKey(standings, "team_key")),
  ];
  const teamCount = teamKeysInStandings.length || leagueSettingsFile?.maxTeams || 0;

  const teamMetrics = buildTeamMetrics(standings);
  const myTeamMetrics = teamMetrics.find(
    (team) => team.teamKey === config.teamKey
  );
  const teamPointsById = myTeamMetrics?.pointsById || new Map();
  const previousSnapshots = readJsonl(SNAPSHOT_LOG);
  const staleRecommendationNames = buildStaleRecommendations(previousSnapshots);

  const categoriesConfig = leagueSettingsFile?.categories || null;
  const categoryAliases = leagueSettingsFile?.categoryAliases || {};
  const battingCategories = categoriesConfig?.batting || [];
  const pitchingCategories = categoriesConfig?.pitching || [];
  const allCategories = [...battingCategories, ...pitchingCategories];

  const resolvedCategories = allCategories.map((key) => {
    const aliases = categoryAliases[key] || [key];
    const statId = resolveStatIdByAliases(statNameMap, aliases);
    const stat = statId ? teamStatsById.get(statId) : null;
    const pointsStat = statId ? teamPointsById.get(statId) : null;
    const points = toNumber(extractStatValue(pointsStat));
    let rank = toNumber(extractStatRank(stat));
    let rankSource = "rank";
    if (rank === null && points !== null && teamCount > 0) {
      rank = Math.round((teamCount - points + 1) * 10) / 10;
      rankSource = "points";
    }
    return {
      key,
      name: aliases[0],
      statId,
      value: extractStatValue(stat),
      points,
      rank,
      rankSource,
    };
  });

  const categoryNextGaps = buildCategoryNextGaps(
    resolvedCategories,
    teamMetrics,
    myTeamMetrics,
    config.teamKey
  );

  const statIdByKey = buildStatIdByKey(resolvedCategories);
  const abStatId = resolveStatIdByAliases(statNameMap, ["At Bats", "AB"]);
  const statIdsForTotals = resolvedCategories
    .map((cat) => cat.statId)
    .filter(Boolean);
  const totalPointsByTeam = computeTotalPoints(teamMetrics, statIdsForTotals);
  const leagueStandings = buildLeagueStandingsSurface({
    resolvedCategories,
    teamMetrics,
    totalPointsByTeam,
  });

  const rankedCategories = resolvedCategories
    .filter((stat) => stat.rank !== null && !Number.isNaN(stat.rank))
    .sort((a, b) => b.rank - a.rank);
  const weakestCategoryKeys = rankedCategories.slice(0, 3).map((cat) => cat.key);

  const learning = loadLearning();
  const targetModel = benchmarkPromotionCandidate() || "baseline";
  const efficiencyScores = buildEfficiencyScores(
    resolvedCategories,
    teamMetrics,
    myTeamMetrics,
    config.teamKey
  );
  const pointGapScores = buildPointGapScores(
    resolvedCategories,
    teamMetrics,
    myTeamMetrics,
    config.teamKey
  );
  const prioritizedCategories = applyLearningBoosts(
    rankedCategories,
    learning,
    efficiencyScores,
    pointGapScores
  );
  const worstCategories = prioritizedCategories.slice(0, 3);
  const worstCategoryKeys = worstCategories.map((cat) => cat.key);
  let targetKeys = [...worstCategoryKeys];

  const overallRank = findAllValuesByKey(teamData, "rank")[0];
  const today = new Date();
  const todayUtc = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  );
  const seasonStart = parseIsoDate(leagueSettingsFile?.season?.start);
  const seasonEnd = parseIsoDate(leagueSettingsFile?.season?.end);
  let seasonProgress = null;
  if (seasonStart && seasonEnd) {
    const totalDays = daysBetweenUtc(seasonStart, seasonEnd) + 1;
    const elapsedDays = daysBetweenUtc(seasonStart, todayUtc) + 1;
    const clampedElapsed = Math.min(Math.max(elapsedDays, 0), totalDays);
    seasonProgress = totalDays > 0 ? clampedElapsed / totalDays : null;
  }

  const gpStatId = resolveStatIdByAliases(statNameMap, [
    "Games Played",
    "Games",
    "GP",
  ]);
  const ipStatId = resolveStatIdByAliases(statNameMap, [
    "Innings Pitched",
    "IP",
  ]);
  let gpValue = gpStatId
    ? toNumber(extractStatValue(teamStatsById.get(gpStatId)))
    : null;
  let ipValue = ipStatId
    ? toNumber(extractStatValue(teamStatsById.get(ipStatId)))
    : null;
  if (gpValue === null) {
    const gpFallback =
      findFirstValueByKey(teamData, "games_played") ??
      findFirstValueByKey(teamData, "games") ??
      findFirstValueByKey(teamData, "gp");
    gpValue = toNumber(
      gpFallback && typeof gpFallback === "object"
        ? gpFallback.value ?? gpFallback.text ?? gpFallback
        : gpFallback
    );
  }
  if (ipValue === null) {
    const ipFallback =
      findFirstValueByKey(teamData, "innings_pitched") ??
      findFirstValueByKey(teamData, "innings") ??
      findFirstValueByKey(teamData, "ip");
    ipValue = toNumber(
      ipFallback && typeof ipFallback === "object"
        ? ipFallback.value ?? ipFallback.text ?? ipFallback
        : ipFallback
    );
  }
  const gpCap = leagueSettingsFile?.caps?.gamesPlayed || null;
  const ipCap = leagueSettingsFile?.caps?.inningsPitched || null;
  const verbose = isVerboseEnabled();

  console.log(cGreen("Daily Recommendation Summary"));
  const progressPercent = seasonProgress !== null ? Math.round(seasonProgress * 100) : null;
  const summaryParts = [];
  if (overallRank) summaryParts.push(`Rank ${overallRank}`);
  if (progressPercent !== null) summaryParts.push(`Season ${progressPercent}%`);
  if (ipCap && ipValue !== null) {
    const ipPace = seasonProgress ? Math.round(ipCap * seasonProgress) : null;
    summaryParts.push(
      `IP ${ipValue}/${ipCap}${ipPace !== null ? ` (pace ${ipPace})` : ""}`
    );
  }
  const leagueDisplay = config.leagueName || config.leagueKey;
  const teamDisplay = config.teamName || config.teamKey;
  console.log(fmtLine(`League ${leagueDisplay} | Team ${teamDisplay}`));
  if (summaryParts.length > 0) {
    console.log(fmtLine(summaryParts.join(" | ")));
  }
  let pointsToNextTeam = null;
  if (totalPointsByTeam.size > 0) {
    const totals = teamMetrics
      .map((team) => ({
        teamKey: team.teamKey,
        teamName: team.teamName,
        totalPoints: totalPointsByTeam.get(team.teamKey),
      }))
      .filter((entry) => entry.totalPoints !== null)
      .sort((a, b) => b.totalPoints - a.totalPoints);
    const myIndex = totals.findIndex((entry) => entry.teamKey === config.teamKey);
    if (myIndex !== -1 && myIndex > 0) {
      const nextTeam = totals[myIndex - 1];
      const myTotal = totals[myIndex].totalPoints;
      const delta = nextTeam.totalPoints - myTotal;
      pointsToNextTeam = {
        delta: Number.isFinite(delta) ? delta : null,
        nextTeamKey: nextTeam.teamKey || null,
        nextTeamName: nextTeam.teamName || null,
      };
      const deltaText =
        delta === 0 ? "0" : delta > 0 ? `+${delta.toFixed(1)}` : `${delta.toFixed(1)}`;
      console.log(cYellow(`Points to next team: ${deltaText} (${nextTeam.teamName})`));
    } else if (myIndex === 0) {
      console.log(cYellow("Points to next team: leading"));
    }
  }
  console.log("");
  printModelStatus();

  const opportunityCategories = rankOpportunityCategories(
    resolvedCategories,
    categoryNextGaps,
    pointsToNextTeam
  );
  const opportunityCategoryKeys = opportunityCategories.slice(0, 3).map((cat) => cat.key);

  let pointGainTargets = [];
  let bestValueTargets = [];
  const pointInfoByKey = new Map();
  if (teamMetrics.length > 0 && myTeamMetrics) {
    if (verbose) console.log(cYellow("Point gains (next team):"));
    const efficiencyRows = [];
    resolvedCategories.forEach((cat) => {
      if (!cat.statId) return;
      const isLower = isLowerBetter(cat.key, cat.name);
      const myStat = myTeamMetrics.statsById.get(cat.statId);
      const myValue = toNumber(extractStatValue(myStat));
      const myPoints = toNumber(
        extractStatValue(myTeamMetrics.pointsById.get(cat.statId))
      );
      if (myValue === null) {
        if (verbose) console.log(fmtBullet(`${cat.key} (${cat.name}): N/A`));
        return;
      }

      const entries = teamMetrics
        .map((team) => {
          const stat = team.statsById.get(cat.statId);
          const value = toNumber(extractStatValue(stat));
          const points = toNumber(
            extractStatValue(team.pointsById.get(cat.statId))
          );
          return { teamKey: team.teamKey, teamName: team.teamName, value, points };
        })
        .filter((entry) => entry.value !== null);

      const sorted = entries.sort((a, b) =>
        isLower ? a.value - b.value : b.value - a.value
      );
      const myIndex = sorted.findIndex(
        (entry) => entry.teamKey === config.teamKey
      );
      if (myIndex === -1) {
        if (verbose) console.log(fmtBullet(`${cat.key} (${cat.name}): N/A`));
        return;
      }

      const mySortedValue = sorted[myIndex].value;
      let groupStart = myIndex;
      while (
        groupStart > 0 &&
        sorted[groupStart - 1].value === mySortedValue
      ) {
        groupStart -= 1;
      }

      if (groupStart === 0) {
        if (verbose) {
          console.log(
            fmtBullet(`${cat.key} (${cat.name}): leading (no immediate point gain)`)
          );
        }
        return;
      }

      const nextBetter = sorted[groupStart - 1];
      const targetValue = nextBetter.value;
      const delta = isLower
        ? mySortedValue - targetValue
        : targetValue - mySortedValue;
      const pointsGain =
        myPoints !== null && nextBetter.points !== null
          ? nextBetter.points - myPoints
          : null;
      const efficiency = efficiencyValue(cat.key, delta, pointsGain);
      const efficiencyText =
        efficiency !== null
          ? `, ${efficiency.toFixed(2)} ${efficiencyLabel(cat.key)}`
          : "";
      const pointsText =
        pointsGain !== null ? ` (+${formatPoints(pointsGain)} pts)` : "";
      const deltaText = formatStatValue(delta, cat.key);
      const targetText = formatStatValue(targetValue, cat.key);
      const directionText = isLower ? `lower by ${deltaText}` : `gain ${deltaText}`;
      const teamName = nextBetter.teamName || "Next team";
      if (verbose) {
        console.log(
          fmtBullet(
            `${cat.key}: ${directionText} vs ${teamName} (${targetText})${pointsText}${efficiencyText}`
          )
        );
      }

      if (efficiency !== null && pointsGain !== null) {
        pointInfoByKey.set(cat.key, {
          pointsGain,
          directionText,
          myValue: mySortedValue,
          myPoints,
          nextTeamKey: nextBetter.teamKey || null,
          nextTeamName: nextBetter.teamName || null,
          nextValue: targetValue,
          nextPoints: nextBetter.points ?? null,
          deltaToNext: delta,
        });
        efficiencyRows.push({
          key: cat.key,
          name: cat.name,
          efficiency,
          label: efficiencyLabel(cat.key),
          pointsGain,
        });
      }
    });

    if (efficiencyRows.length > 0) {
      const topLimit = 3;
      const sorted = [...efficiencyRows].sort(
        (a, b) => b.efficiency - a.efficiency
      );
      const pointSorted = [...efficiencyRows].sort((a, b) => {
        if (b.pointsGain !== a.pointsGain) return b.pointsGain - a.pointsGain;
        return b.efficiency - a.efficiency;
      });
      pointGainTargets = pointSorted.slice(0, topLimit).map((row) => row.key);
      if (verbose) {
        console.log(cYellow("Best value (points per unit):"));
        sorted.slice(0, topLimit).forEach((row) => {
          console.log(
            fmtBullet(
              `${row.key} (${row.name}): ${formatEfficiency(row.efficiency)} ${row.label}`
            )
          );
        });
        console.log("");
      }
      bestValueTargets = sorted.slice(0, topLimit).map((row) => row.key);
    }
  }

  const primaryTargetKeys =
    targetModel === "opportunity"
      ? opportunityCategoryKeys
      : targetModel === "weakest"
      ? weakestCategoryKeys
      : pointGainTargets.length > 0
        ? pointGainTargets
        : worstCategoryKeys;
  targetKeys = [...primaryTargetKeys];
  const focusKeys =
    targetModel === "weakest" || targetModel === "opportunity"
      ? [...new Set(primaryTargetKeys)]
      : [...new Set([...primaryTargetKeys, ...bestValueTargets])];
  const needsSaves = focusKeys.includes("SV");
  const currentSaves = toNumber(
    resolvedCategories.find((cat) => cat.key === "SV")?.value
  );
  const savesEmergency = needsSaves && currentSaves !== null && currentSaves <= 1;

  if (targetKeys.length > 0) {
    console.log(
      cYellow(
        targetModel === "opportunity"
          ? "Targets (champion: rank opportunity categories):"
          : targetModel === "weakest"
          ? "Targets (champion: weakest categories):"
          : pointGainTargets.length > 0
          ? "Targets (closest point gains):"
          : "Targets (lowest ranks):"
      )
    );
    const categoryByKey = new Map(resolvedCategories.map((cat) => [cat.key, cat]));
    targetKeys.forEach((key) => {
      const cat = categoryByKey.get(key);
      if (!cat) return;
      const rankLabel =
        cat.rankSource === "points" && cat.points !== null
          ? `~rank ${formatRank(cat.rank)} (points ${cat.points})`
          : `rank ${formatRank(cat.rank)}`;
      const info = pointInfoByKey.get(key);
      const infoText =
        info && info.pointsGain !== null
          ? `, next ${info.directionText} (+${formatPoints(info.pointsGain)} pts)`
          : "";
      const opportunity = opportunityCategories.find((row) => row.key === key);
      const opportunityText =
        targetModel === "opportunity" && opportunity
          ? `, opp ${opportunity.opportunityScore.toFixed(1)}`
          : "";
      console.log(fmtBullet(`${cat.key} ${rankLabel}, val ${cat.value}${infoText}${opportunityText}`));
    });
  } else {
    console.log(fmtLine("Could not infer category ranks from standings."));
  }
  console.log("");

  let rosterState = [];
  let rosterMappedPlayers = [];
  let addBattingCandidates = [];
  let addPitchingCandidates = [];
  let addGeneralCandidates = [];
  let addPositionCandidates = [];
  let addPositionAllCandidates = [];
  let addBattingLabel = null;
  let addPitchingLabel = null;
  let addGeneralLabel = null;
  let addPositionLabel = null;
  let addPositionIsPitcher = null;
  let battingFocusKeys = [];
  let pitchingFocusKeys = [];
  let startSelections = [];
  let startPlans = [];
  let startContext = {
    scheduleAvailable: false,
    dateRange: null,
  };
  let startDiagnostics = null;
  let startLabel = null;
  let startMessage = null;
  let dropHeader = null;
  let dropMessage = null;
  let dropLines = [];
  let dropSuggestions = [];
  let blockedAddCandidates = [];
  let dropDiagnostics = {
    addCandidateCount: 0,
    safeDropCandidates: 0,
    statusDropCandidates: 0,
    dropPoolCandidates: 0,
    protectedInjuryReviews: [],
    staleProtectedInjuryReviews: [],
    blockedProtectedDrops: [],
    blockedAddCandidates: [],
    noAddReason: null,
    noDropReason: null,
  };
  const actionSuggestions = {
    addBatting: [],
    addPitching: [],
    add: [],
    start: [],
    drop: [],
  };
  const actionDetails = {
    addBatting: [],
    addPitching: [],
    add: [],
    start: [],
    drop: [],
  };

  if (snapshotOnly) {
    // Minimal run: log snapshot + effectiveness without computing adds/drops/starts.
    try {
      const roster = await yahooRequest({
        url: `${FANTASY_API_BASE}/team/${config.teamKey}/roster?format=json`,
        accessToken,
      });
      const rosterPlayers = findAllValuesByKey(roster, "player");
      rosterState = buildRosterState(rosterPlayers);
      rosterMappedPlayers = rosterPlayers.map((player) => {
        const name = extractPlayerName(player);
        const positions = extractPlayerPositions(player);
        const selected = extractSelectedPositions(player);
        const rank = extractPlayerRank(player);
        const playerKey = extractPlayerKey(player);
        const stats = extractPlayerStats(player);
        const status = extractPlayerStatus(player);
        return {
          name,
          positions,
          selected,
          selectedPrimary: extractPrimarySelectedPosition(selected),
          rank,
          playerKey,
          playerId: extractPlayerId(player),
          teamAbbr: extractPlayerTeamAbbr(player),
          teamName: extractPlayerTeamName(player),
          stats,
          status,
          isPitcher: isPitcherPositions(positions),
          isBench: isBenchPosition(selected),
          isIL: isILPosition(selected) || isILStatus(status),
        };
      });
    } catch {
      // ok: snapshot will still contain standings/category data
    }
    const snapshotDoNotDrop = new Set(
      (config.doNotDrop || []).map(normalizeNameKey)
    );
    const protectedInjuryReviews = buildProtectedInjuryReviewStates(
      config,
      snapshotDoNotDrop,
      rosterMappedPlayers
    );
    dropDiagnostics = {
      ...dropDiagnostics,
      protectedInjuryReviews,
      staleProtectedInjuryReviews: protectedInjuryReviews.filter(
        (state) => state.reviewStatus === "stale"
      ),
      blockedProtectedDrops: protectedInjuryReviews.filter(
        (state) => !state.dropEligible
      ),
    };

    console.log(cYellow("Actions: snapshot-only (no recommendations computed)."));
    console.log("");
    const featureInputs = buildSnapshotFeatures({
      leagueSettingsFile,
      resolvedCategories,
      focusKeys,
      targetModel,
      startContext,
      startDiagnostics,
      pointInfoByKey,
      categoryNextGaps,
      rosterMappedPlayers,
      startPlans: [],
      actionSuggestions,
      actionDetails,
      dropSuggestions: [],
      addCandidates: [],
      dropDiagnostics,
    });
    await finalizeAndLogRun({
      config,
      overallRank,
      seasonProgress,
      gpValue,
      ipValue,
      gpCap,
      ipCap,
      resolvedCategories,
      targetKeys,
      bestValueTargets,
      focusKeys,
      pointsToNextTeam,
      categoryNextGaps,
      leagueStandings,
      actionSuggestions,
      actionDetails,
      rosterState,
      learning,
      featureInputs,
    });
    return;
  }

  try {
    const topLimit = getTopLimit(3);
    const freeAgentCount = positionFilter
      ? FREE_AGENT_COUNT_POSITION
      : needsSaves
        ? FREE_AGENT_COUNT_SAVES
      : FREE_AGENT_COUNT;
    const positionParam = positionFilter ? `;position=${positionFilter}` : "";
    const freeAgents = await yahooRequest({
      url: `${FANTASY_API_BASE}/league/${config.leagueKey}/players;status=A${positionParam};sort=AR;count=${freeAgentCount}?format=json`,
      accessToken,
    });
    writeDebugJson("free-agents", freeAgents);

    const players = findAllValuesByKey(freeAgents, "player");
    if (players.length > 0) {
      const battingNeeds = focusKeys.some((cat) =>
        battingCategories.includes(cat)
      );
      const pitchingNeeds = focusKeys.some((cat) =>
        pitchingCategories.includes(cat)
      );
      const battingFocus = focusKeys.filter((cat) =>
        battingCategories.includes(cat)
      );
      const pitchingFocus = focusKeys.filter((cat) =>
        pitchingCategories.includes(cat)
      );
      battingFocusKeys = battingFocus;
      pitchingFocusKeys = pitchingFocus;

      const filterByNeed = (player) => {
        const positions = extractPlayerPositions(player);
        const isPitcher = isPitcherPositions(positions);
        if (battingNeeds && !pitchingNeeds) return !isPitcher;
        if (pitchingNeeds && !battingNeeds) return isPitcher;
        return true;
      };

      const basePlayers = positionFilter ? players : players.filter(filterByNeed);
      const allSuggestedPlayers = basePlayers.map((player) => ({
          player,
          name: extractPlayerName(player),
          positions: extractPlayerPositions(player),
          isPitcher: isPitcherPositions(extractPlayerPositions(player)),
          rank: extractPlayerRank(player),
          playerKey: extractPlayerKey(player),
        }));
      blockedAddCandidates = allSuggestedPlayers
        .map((item) => ({ item, block: getAddBlock(config, item) }))
        .filter(({ block }) => block)
        .map(({ item, block }) => ({
          name: item.name,
          playerKey: item.playerKey || null,
          positions: item.positions || [],
          reason:
            typeof block === "object"
              ? block.reason || "Configured add block."
              : "Configured add block.",
          unavailableUntil:
            typeof block === "object"
              ? block.unavailableUntil || block.until || null
              : null,
        }));
      const suggestedPlayers = allSuggestedPlayers.filter(
        (item) => !getAddBlock(config, item)
      );
      dropDiagnostics = {
        ...dropDiagnostics,
        blockedAddCandidates,
      };
      if (suggestedPlayers.length > 0) {
        if (positionFilter) {
          const positionCandidates = suggestedPlayers.filter((item) =>
            positionMatches(item.positions, positionFilter)
          );
          addPositionLabel = `ADD (position ${positionFilter}):`;
          addPositionIsPitcher = isPitcherFilter(positionFilter);
          addPositionAllCandidates = applyStalePenalty(
            positionCandidates,
            staleRecommendationNames
          );
          addPositionCandidates = addPositionAllCandidates.slice(0, topLimit);
        } else if (battingNeeds) {
          addBattingLabel = `ADD (batting: ${battingFocus.join(", ")}):`;
          const battingCandidates = suggestedPlayers.filter(
            (item) => !item.isPitcher
          );
          addBattingCandidates = applyStalePenalty(
            battingCandidates,
            staleRecommendationNames
          ).slice(0, topLimit);
        }

        if (!positionFilter && pitchingNeeds) {
          addPitchingLabel = `ADD (pitching: ${pitchingFocus.join(", ")}):`;
          let pitchingCandidates = suggestedPlayers.filter((item) =>
            item.isPitcher
          );
          if (pitchingFocus.includes("SV")) {
            pitchingCandidates = [...pitchingCandidates].sort((a, b) => {
              const aIsRP = a.positions.includes("RP");
              const bIsRP = b.positions.includes("RP");
              if (aIsRP === bIsRP) return 0;
              return aIsRP ? -1 : 1;
            });
          }
          addPitchingCandidates = applyStalePenalty(
            pitchingCandidates,
            staleRecommendationNames
          ).slice(0, needsSaves && pitchingFocus.includes("SV") ? Math.max(topLimit, 40) : topLimit);
        }

        if (!positionFilter && !battingNeeds && !pitchingNeeds) {
          addGeneralLabel = "ADD:";
          addGeneralCandidates = applyStalePenalty(
            suggestedPlayers,
            staleRecommendationNames
          ).slice(0, topLimit);
        }
      } else {
        console.log("Actions: ADD list unavailable.");
      }
    }
  } catch (error) {
    console.log("Free agent list unavailable (endpoint may be restricted).");
  }

  try {
    const topLimit = getTopLimit(3);
    let { roster, statType, hasStats } = await fetchRosterWithStats({
      accessToken,
      teamKey: config.teamKey,
    });
    writeDebugJson(`roster-${statType || "base"}`, roster);

    const doNotDrop = new Set(
      (config.doNotDrop || []).map(normalizeNameKey)
    );
    const rosterPlayers = findAllValuesByKey(roster, "player");
    rosterState = buildRosterState(rosterPlayers);
    const mappedPlayers = rosterPlayers
      .map((player) => {
        const name = extractPlayerName(player);
        const positions = extractPlayerPositions(player);
        const selected = extractSelectedPositions(player);
        const rank = extractPlayerRank(player);
        const playerKey = extractPlayerKey(player);
        const stats = extractPlayerStats(player);
        const status = extractPlayerStatus(player);
        return {
          name,
          positions,
          selected,
          selectedPrimary: extractPrimarySelectedPosition(selected),
          rank,
          playerKey,
          playerId: extractPlayerId(player),
          teamAbbr: extractPlayerTeamAbbr(player),
          teamName: extractPlayerTeamName(player),
          stats,
          status,
          isPitcher: isPitcherPositions(positions),
          isBench: isBenchPosition(selected),
          isIL: isILPosition(selected) || isILStatus(status),
        };
      });
    rosterMappedPlayers = mappedPlayers;
    const protectedInjuryReviews = buildProtectedInjuryReviewStates(
      config,
      doNotDrop,
      mappedPlayers
    );
    dropDiagnostics = {
      ...dropDiagnostics,
      protectedInjuryReviews,
      staleProtectedInjuryReviews: protectedInjuryReviews.filter(
        (state) => state.reviewStatus === "stale"
      ),
      blockedProtectedDrops: protectedInjuryReviews.filter(
        (state) => !state.dropEligible
      ),
    };
    const activeCatchers = mappedPlayers.filter(
      (player) =>
        isCatcherPositions(player.positions) &&
        !isUnavailableStatus(player.status) &&
        !player.isIL
    );
    const canDropCatcher = (player) => {
      if (!isCatcherPositions(player.positions)) return true;
      return activeCatchers.some((catcher) => catcher.playerKey !== player.playerKey);
    };
    const allBenchPlayers = mappedPlayers.filter((player) => player.isBench);
    const statusAnywhereCandidates = mappedPlayers.filter(
      (player) =>
        isDropStatus(player.status) &&
        canDropCatcher(player) &&
        !isDropBlockedByDoNotDrop(config, doNotDrop, player)
    );
    let benchPlayers = allBenchPlayers.filter((player) => !player.isIL);

    if (!hasStats) {
      const benchKeys = allBenchPlayers
        .map((player) => player.playerKey)
        .filter(Boolean);
      const statsResult = await fetchPlayerStatsByKeys({
        accessToken,
        playerKeys: benchKeys,
      });
      if (statsResult.hasStats) {
        hasStats = true;
        statType = statsResult.statType;
        const applyStats = (player) => ({
          ...player,
          stats: statsResult.statsByKey.get(player.playerKey) || new Map(),
        });
        benchPlayers = benchPlayers.map(applyStats);
        allBenchPlayers.forEach((player, index) => {
          allBenchPlayers[index] = applyStats(player);
        });
        mappedPlayers.forEach((player) => {
          if (statsResult.statsByKey.has(player.playerKey)) {
            player.stats = statsResult.statsByKey.get(player.playerKey) || new Map();
          }
        });
      }
    }

    const scheduleStart = todayDateString();
    const scheduleEnd = addDaysLocalDateString(scheduleStart, 1);
    startContext = await fetchMlbScheduleContext({
      startDate: scheduleStart,
      endDate: scheduleEnd,
    });
    mappedPlayers.forEach((player) => {
      const startModel = buildStartScore({
        player,
        focusKeys,
        statIdByKey,
        scheduleContext: startContext,
      });
      player.startScore = startModel.score;
      player.startReasons = startModel.reasons;
      player.startSchedule = startModel.schedule;
    });
    benchPlayers = benchPlayers.map((player) => {
      const mapped = mappedPlayers.find((p) => p.playerKey === player.playerKey);
      return mapped || player;
    });
    allBenchPlayers.forEach((player, index) => {
      const mapped = mappedPlayers.find((p) => p.playerKey === player.playerKey);
      if (mapped) allBenchPlayers[index] = mapped;
    });

    if (benchPlayers.length > 0) {
      const dropRankFloorPrimary = savesEmergency ? 60 : DROP_RANK_FLOOR;
      const dropRankFloorSecondary = savesEmergency
        ? 40
        : DROP_RANK_FLOOR_SECONDARY;
      const battingNeeds = focusKeys.some((key) => battingCategories.includes(key));
      const pitchingNeeds = focusKeys.some((key) =>
        pitchingCategories.includes(key)
      );

      let startCandidates = benchPlayers
        .filter((player) => !player.isIL)
        .filter((player) => !isUnavailableStatus(player.status))
        .filter((player) =>
        battingNeeds && pitchingNeeds
          ? true
          : battingNeeds
            ? !player.isPitcher
            : pitchingNeeds
              ? player.isPitcher
              : false
      );
      startCandidates = rankStartCandidates({
        candidates: applyStalePenalty(startCandidates, staleRecommendationNames),
        focusKeys,
        statIdByKey,
        scheduleContext: startContext,
      });
      startDiagnostics = {
        scheduleAvailable: !!startContext.scheduleAvailable,
        dateRange: startContext.dateRange || null,
        candidates: startCandidates.slice(0, 10).map((player) => ({
          playerKey: player.playerKey || null,
          name: player.name,
          selectedPrimary: player.selectedPrimary || null,
          positions: player.positions || [],
          teamAbbr: player.teamAbbr || null,
          score: toNumber(player.startScore),
          schedule: player.startSchedule || null,
          reasons: player.startReasons || [],
        })),
      };
      if (startCandidates.length === 0 && benchPlayers.length > 0) {
        startCandidates = rankStartCandidates({
          candidates: applyStalePenalty(
            benchPlayers
            .filter((player) => !player.isIL)
            .filter((player) => !isUnavailableStatus(player.status)),
            staleRecommendationNames
          ),
          focusKeys,
          statIdByKey,
          scheduleContext: startContext,
        });
        startDiagnostics = {
          scheduleAvailable: !!startContext.scheduleAvailable,
          dateRange: startContext.dateRange || null,
          candidates: startCandidates.slice(0, 10).map((player) => ({
            playerKey: player.playerKey || null,
            name: player.name,
            selectedPrimary: player.selectedPrimary || null,
            positions: player.positions || [],
            teamAbbr: player.teamAbbr || null,
            score: toNumber(player.startScore),
            schedule: player.startSchedule || null,
            reasons: player.startReasons || [],
          })),
        };
      }
      startSelections = startCandidates.slice(0, topLimit);
      if (startSelections.length > 0) {
        startLabel =
          battingNeeds || pitchingNeeds
            ? "START (bench fits needs):"
            : "START (bench best available):";
        startPlans = buildStartPlans({
          startSelections,
          rosterMappedPlayers: mappedPlayers,
          rosterPositions: leagueSettingsFile?.rosterPositions || [],
          battingCategories,
          pitchingCategories,
          focusKeys,
          statIdByKey,
        });
        const planByKey = new Map(startPlans.map((plan) => [plan.playerKey, plan]));
        startSelections = startSelections.filter((player) => {
          const plan = planByKey.get(player.playerKey);
          return !!plan?.startSlot;
        });
        startPlans = startPlans.filter((plan) => !!plan.startSlot);
        if (startSelections.length === 0) {
          startMessage = "START: none (no bench player clears schedule/risk upgrade threshold).";
        }
      } else {
        startMessage = "START: none (bench does not fit needs).";
      }

      const startKeys = new Set(startSelections.map((player) => playerKey(player)));
      const benchWithRank = allBenchPlayers.filter((player) => player.rank !== null);
      const isProtectedBenchPlayer = (player) =>
        player.rank !== null && player.rank <= PROTECT_TOP_YAHOO_RANK;
      const dropPool = allBenchPlayers.filter(
        (player) =>
          !startKeys.has(playerKey(player)) &&
          !isDropBlockedByDoNotDrop(config, doNotDrop, player) &&
          canDropCatcher(player) &&
          !isProtectedBenchPlayer(player) &&
          (savesEmergency
            ? true
            : player.rank === null || player.rank >= dropRankFloorPrimary) &&
          !(player.isPitcher && player.positions.includes("SP") && player.rank === null)
      );
      dropDiagnostics = {
        ...dropDiagnostics,
        statusDropCandidates: statusAnywhereCandidates.length,
        dropPoolCandidates: dropPool.length,
      };
      const statKeysForType = (isPitcher) =>
        isPitcher ? pitchingCategories : battingCategories;
      const weakKeysForType = (isPitcher) => {
        const weak = focusKeys.filter((key) =>
          isPitcher ? pitchingCategories.includes(key) : battingCategories.includes(key)
        );
        return weak.length > 0 ? weak : statKeysForType(isPitcher);
      };

      let dropPrinted = false;
      const statusCandidates = statusAnywhereCandidates.filter(
        (player) => !startKeys.has(playerKey(player))
      );
      if (statusCandidates.length > 0) {
        dropHeader = "DROP (status: NA/IL):";
        statusCandidates.slice(0, topLimit).forEach((player) => {
          const position = player.positions.join(", ");
          const statusText = player.status ? `${player.status}` : "STATUS";
          const injuryReview = getAllowedProtectedInjuryDropReview(config, player);
          dropLines.push(
            `- ${player.name} ${position ? `(${position})` : ""} (${statusText})`.trim()
          );
            dropSuggestions.push({
              name: player.name,
              playerKey: player.playerKey,
              isPitcher: player.isPitcher,
              rank: player.rank,
              statusDrop: true,
              positions: player.positions,
              status: player.status,
              injuryReview: injuryReview
                ? {
                    reviewedAt: injuryReview.reviewedAt || null,
                    expectedOutDays: injuryReview.expectedOutDays ?? null,
                    sources: Array.isArray(injuryReview.sources)
                      ? injuryReview.sources
                      : [],
                  }
                : null,
              reason: injuryReview
                ? `Protected IL exception: injury news reviewed ${injuryReview.reviewedAt}; more likely than not out beyond 30 days.`
                : `Status ${statusText} makes this the safest roster churn.`,
            });
        });
        dropPrinted = true;
      }
      if (!dropPrinted && hasStats) {
        const dropCandidates = applyStalePenalty(
          dropPool
          .map((player) => {
            const keys = weakKeysForType(player.isPitcher);
            let score = 0;
            let hasStat = false;
            keys.forEach((key) => {
              const statId = statIdByKey.get(key);
              if (!statId) return;
              const value = player.stats.get(statId);
              if (value === null || value === undefined) return;
              hasStat = true;
              score += isLowerBetter(key, key) ? -value : value;
            });
            return { ...player, score, hasStat };
          })
          .filter((player) => player.hasStat)
          .sort((a, b) => a.score - b.score),
          staleRecommendationNames
        );

        if (dropCandidates.length > 0) {
          dropHeader = `DROP (bench, recent ${statType}):`;
          dropCandidates.slice(0, topLimit).forEach((player, idx) => {
            const position = player.positions.join(", ");
            const confidence = dropConfidenceTag(
              statType,
              idx,
              dropCandidates.length,
              true
            );
            dropLines.push(
              `- ${player.name} ${position ? `(${position})` : ""} (${confidence})`.trim()
            );
            dropSuggestions.push({
              name: player.name,
              playerKey: player.playerKey,
              isPitcher: player.isPitcher,
              rank: player.rank,
              statsScore: player.score,
              statusDrop: false,
              positions: player.positions,
              status: player.status,
              reason: `Lowest bench fit by recent ${statType} stats for ${weakKeysForType(player.isPitcher).join(", ")}.`,
            });
          });
          dropPrinted = true;
        }
      }

      if (!dropPrinted && benchWithRank.length > 0) {
        const fallback = applyStalePenalty(
          benchWithRank
            .filter(
              (player) =>
                !startKeys.has(playerKey(player)) &&
                !isDropBlockedByDoNotDrop(config, doNotDrop, player) &&
                (savesEmergency
                  ? !isProtectedBenchPlayer(player)
                  : player.rank >= dropRankFloorPrimary)
            )
            .sort((a, b) => b.rank - a.rank),
          staleRecommendationNames
        );
        if (fallback.length > 0) {
          dropHeader = "DROP (bench, lowest Yahoo rank):";
          fallback.slice(0, topLimit).forEach((player) => {
            const position = player.positions.join(", ");
            const rankText = player.rank ? `rank ${player.rank}` : "rank N/A";
            dropLines.push(
              `- ${player.name} ${position ? `(${position})` : ""} ${rankText} (LOW)`.trim()
            );
            dropSuggestions.push({
              name: player.name,
              playerKey: player.playerKey,
              isPitcher: player.isPitcher,
              rank: player.rank,
              statusDrop: false,
              positions: player.positions,
              status: player.status,
              reason: `Lowest bench Yahoo rank among safe drop candidates.`,
            });
          });
        }
      }

      if (dropSuggestions.length === 0 && benchWithRank.length > 0) {
        const secondary = applyStalePenalty(
          benchWithRank
            .filter(
              (player) =>
                !startKeys.has(playerKey(player)) &&
                !isDropBlockedByDoNotDrop(config, doNotDrop, player) &&
                !savesEmergency &&
                player.rank >= dropRankFloorSecondary &&
                player.rank < dropRankFloorPrimary
            )
            .sort((a, b) => b.rank - a.rank),
          staleRecommendationNames
        );
        if (secondary.length > 0) {
          dropHeader = "DROP (bench, secondary rank):";
          secondary.slice(0, topLimit).forEach((player) => {
            const position = player.positions.join(", ");
            const rankText = player.rank ? `rank ${player.rank}` : "rank N/A";
            dropLines.push(
              `- ${player.name} ${position ? `(${position})` : ""} ${rankText} (LOW)`.trim()
            );
            dropSuggestions.push({
              name: player.name,
              playerKey: player.playerKey,
              isPitcher: player.isPitcher,
              rank: player.rank,
              statusDrop: false,
              positions: player.positions,
              status: player.status,
              reason: `Secondary bench rank candidate after stricter drop checks found no option.`,
            });
          });
        }
      }

      if (dropSuggestions.length === 0 && !dropPrinted) {
        dropMessage =
          protectedInjuryReviews.length > 0 && dropPool.length === 0
            ? "DROP: none (no safe drop candidates after protections)."
            : "DROP: recent stats unavailable.";
        dropDiagnostics = {
          ...dropDiagnostics,
          noDropReason: dropMessage.replace(/^DROP:\s*/i, ""),
        };
      }
    }
  } catch (error) {
    console.log("Roster actions unavailable (endpoint may be restricted).");
  }

  const printActionsHeader = (() => {
    let printed = false;
    return () => {
      if (!printed) {
        console.log(cYellow("Actions:"));
        printed = true;
      }
    };
  })();

  let dropHittersQueue = dropSuggestions
    .filter((drop) => !drop.isPitcher)
    .map((d) => ({ ...d }));
  let dropPitchersQueue = dropSuggestions
    .filter((drop) => drop.isPitcher)
    .map((d) => ({ ...d }));
  const takeAnyDropName = () => {
    if (dropHittersQueue.length > 0) return dropHittersQueue.shift().name;
    if (dropPitchersQueue.length > 0) return dropPitchersQueue.shift().name;
    return null;
  };
  const findMatchingDrop = (candidate, isPitcher) => {
    if (!candidate) return null;
    const queue = isPitcher ? dropPitchersQueue : dropHittersQueue;
    for (let i = 0; i < queue.length; i += 1) {
      const drop = queue[i];
      if (savesEmergency && needsSaves && isPitcher && candidate?.positions?.includes("RP")) {
        queue.splice(i, 1);
        return drop.name;
      }
      if (drop.statusDrop && candidate.rank !== null && candidate.rank !== undefined) {
        queue.splice(i, 1);
        return drop.name;
      }
      if (drop.statusDrop) {
        queue.splice(i, 1);
        return drop.name;
      }
      if (
        candidate.rank !== null &&
        candidate.rank !== undefined &&
        drop.rank !== null &&
        drop.rank !== undefined
      ) {
        const rankOk = isMeaningfulUpgrade(candidate.rank, drop.rank);
        const statOk =
          candidate.statsScore !== null &&
          candidate.statsScore !== undefined &&
          drop.statsScore !== null &&
          drop.statsScore !== undefined &&
          candidate.statsScore - drop.statsScore >= ADD_STAT_SCORE_IMPROVEMENT;
        if (rankOk || statOk) {
          queue.splice(i, 1);
          return drop.name;
        }
        continue;
      }
      if (
        candidate.statsScore !== null &&
        candidate.statsScore !== undefined &&
        drop.statsScore !== null &&
        drop.statsScore !== undefined
      ) {
        if (candidate.statsScore - drop.statsScore < ADD_STAT_SCORE_IMPROVEMENT) continue;
        queue.splice(i, 1);
        return drop.name;
      }
      if (
        drop.statusDrop &&
        candidate.statsScore !== null &&
        candidate.statsScore !== undefined
      ) {
        queue.splice(i, 1);
        return drop.name;
      }
    }
    return null;
  };
  const findMatchingDropGeneral = (candidate) => {
    const hitterDrop = findMatchingDrop(candidate, false);
    if (hitterDrop) return hitterDrop;
    return findMatchingDrop(candidate, true);
  };

  const allAddCandidates = [
    ...addBattingCandidates,
    ...addPitchingCandidates,
    ...addGeneralCandidates,
    ...addPositionCandidates,
    ...addPositionAllCandidates,
  ];
  dropDiagnostics = {
    ...dropDiagnostics,
    addCandidateCount: allAddCandidates.length,
    safeDropCandidates: dropSuggestions.length,
    blockedAddCandidates,
  };
  const addKeys = allAddCandidates.map((candidate) => candidate.playerKey).filter(Boolean);
  if (addKeys.length > 0) {
    const addStatsResult = await fetchPlayerStatsByKeys({
      accessToken,
      playerKeys: addKeys,
      statTypeOverride: "season",
    });
    if (addStatsResult.hasStats) {
      const applyAddStats = (candidate) => ({
        ...candidate,
        stats: addStatsResult.statsByKey.get(candidate.playerKey) || new Map(),
      });
      addBattingCandidates = addBattingCandidates.map(applyAddStats);
      addPitchingCandidates = addPitchingCandidates.map(applyAddStats);
      addGeneralCandidates = addGeneralCandidates.map(applyAddStats);
      addPositionCandidates = addPositionCandidates.map(applyAddStats);
      addPositionAllCandidates = addPositionAllCandidates.map(applyAddStats);
    }
  }

  const battingStatKeys =
    battingFocusKeys.length > 0 ? battingFocusKeys : battingCategories;
  const pitchingStatKeys =
    pitchingFocusKeys.length > 0 ? pitchingFocusKeys : pitchingCategories;
  const projectedAddKeys = [
    ...addBattingCandidates,
    ...addPitchingCandidates,
    ...addGeneralCandidates,
    ...addPositionCandidates,
    ...(positionFilter === "C" ? addPositionAllCandidates.slice(0, 25) : []),
  ]
    .map((candidate) => candidate.playerKey)
    .filter(Boolean);
  const projectionKeys = uniqueLimit(
    [...projectedAddKeys, ...dropSuggestions.map((drop) => drop.playerKey).filter(Boolean)],
    MAX_HISTORY_KEYS
  );
  let currentSeasonStatsByKey = new Map();
  let historyByKey = new Map();
  if (projectionKeys.length > 0) {
    const currentSeasonResult = await fetchPlayerStatsByKeys({
      accessToken,
      playerKeys: projectionKeys,
      statTypeOverride: "season",
    });
    currentSeasonStatsByKey = currentSeasonResult.statsByKey || new Map();
    try {
      const year = new Date().getFullYear();
      historyByKey = await fetchPlayerHistory({
        accessToken,
        playerKeys: projectionKeys,
        endSeasonYear: year,
        seasonsBack: HISTORY_SEASONS,
      });
    } catch {
      historyByKey = new Map();
    }
  }

  // Unsupervised player archetypes: cluster free agents + roster players on (season + lastmonth) stat rates.
  const isPitcherByKey = new Map();
  rosterMappedPlayers.forEach((p) => {
    if (p?.playerKey) isPitcherByKey.set(p.playerKey, !!p.isPitcher);
  });
  allAddCandidates.forEach((c) => {
    if (c?.playerKey) isPitcherByKey.set(c.playerKey, !!c.isPitcher);
  });
  dropSuggestions.forEach((d) => {
    if (d?.playerKey) isPitcherByKey.set(d.playerKey, !!d.isPitcher);
  });

  const archetypePoolKeys = uniqueLimit(
    [
      ...allAddCandidates.map((c) => c.playerKey),
      ...rosterMappedPlayers.map((p) => p.playerKey),
    ].filter(Boolean),
    MAX_ARCHETYPE_KEYS
  );

  let archetypeSeasonStatsByKey = new Map();
  let archetypeLastMonthStatsByKey = new Map();
  if (archetypePoolKeys.length > 0) {
    try {
      const seasonRes = await fetchPlayerStatsByKeys({
        accessToken,
        playerKeys: archetypePoolKeys,
        statTypeOverride: "season",
      });
      archetypeSeasonStatsByKey = seasonRes.statsByKey || new Map();
    } catch {
      archetypeSeasonStatsByKey = new Map();
    }
    try {
      const lastRes = await fetchPlayerStatsByKeys({
        accessToken,
        playerKeys: archetypePoolKeys,
        statTypeOverride: "lastmonth",
      });
      archetypeLastMonthStatsByKey = lastRes.statsByKey || new Map();
    } catch {
      archetypeLastMonthStatsByKey = new Map();
    }
  }

  const hitterArchetypes = buildArchetypes({
    poolPlayers: archetypePoolKeys.filter((pk) => isPitcherByKey.get(pk) === false),
    isPitcher: false,
    statKeys: battingCategories,
    statIdByKey,
    seasonStatsByKey: archetypeSeasonStatsByKey,
    lastMonthStatsByKey: archetypeLastMonthStatsByKey,
    abStatId,
    ipStatId,
    focusKeys,
  });
  const pitcherArchetypes = buildArchetypes({
    poolPlayers: archetypePoolKeys.filter((pk) => isPitcherByKey.get(pk) === true),
    isPitcher: true,
    statKeys: pitchingCategories,
    statIdByKey,
    seasonStatsByKey: archetypeSeasonStatsByKey,
    lastMonthStatsByKey: archetypeLastMonthStatsByKey,
    abStatId,
    ipStatId,
    focusKeys,
  });

  const hitterPoolKeys = uniqueLimit(
    [
      ...allAddCandidates.filter((c) => !c.isPitcher).map((c) => c.playerKey),
      ...dropSuggestions.filter((d) => !d.isPitcher).map((d) => d.playerKey),
    ].filter(Boolean),
    MAX_HISTORY_KEYS
  );
  const pitcherPoolKeys = uniqueLimit(
    [
      ...allAddCandidates.filter((c) => c.isPitcher).map((c) => c.playerKey),
      ...dropSuggestions.filter((d) => d.isPitcher).map((d) => d.playerKey),
    ].filter(Boolean),
    MAX_HISTORY_KEYS
  );

  const buildZContext = (statKeys, isPitcher, poolKeys) => {
    const ctx = new Map();
    statKeys.forEach((key) => {
      const statId = statIdByKey.get(key);
      if (!statId) return;
      const sampleStatId = isPitcher ? ipStatId : abStatId;
      const vals = poolKeys
        .map((pk) =>
          expectedRate({
            statKey: key,
            statId,
            isPitcher,
            currentStats: currentSeasonStatsByKey.get(pk) || null,
            historySeasonStats: historyByKey.get(pk) || null,
            sampleStatId,
          })
        )
        .filter((v) => v !== null && v !== undefined)
        .map((v) => Number(v));
      const { mean, std } = safeMeanStd(vals);
      const weight = targetKeys.includes(key) ? 1.5 : 1;
      ctx.set(key, { mean, std, weight });
    });
    return ctx;
  };

  const hitterZ = buildZContext(battingStatKeys, false, hitterPoolKeys);
  const pitcherZ = buildZContext(pitchingStatKeys, true, pitcherPoolKeys);

  const fallbackScore = (candidate, isPitcher) =>
    computeStatScore(
      candidate.stats,
      isPitcher ? pitchingStatKeys : battingStatKeys,
      statIdByKey
    );

  const applyProjected = (candidate, isPitcher) => {
    const zContext = isPitcher ? pitcherZ : hitterZ;
    const projected = computeProjectedZScore({
      playerKey: candidate.playerKey,
      isPitcher,
      statKeys: isPitcher ? pitchingStatKeys : battingStatKeys,
      statIdByKey,
      currentSeasonStatsByKey,
      historyByKey,
      abStatId,
      ipStatId,
      zContext,
    });
    const archetype = isPitcher
      ? pitcherArchetypes.get(candidate.playerKey)
      : hitterArchetypes.get(candidate.playerKey);
    return {
      ...candidate,
      statsScore: projected !== null && projected !== undefined ? projected : fallbackScore(candidate, isPitcher),
      archetype: archetype?.label || null,
      archetypeFitScore: archetype?.fitScore ?? 0,
    };
  };

  addBattingCandidates = addBattingCandidates.map((c) => applyProjected(c, false));
  addPitchingCandidates = addPitchingCandidates.map((c) => applyProjected(c, true));
  addGeneralCandidates = addGeneralCandidates.map((c) =>
    applyProjected(c, c.isPitcher)
  );
  addPositionCandidates = addPositionCandidates.map((c) =>
    applyProjected(c, addPositionIsPitcher ?? c.isPitcher)
  );
  addPositionAllCandidates = addPositionAllCandidates.map((c) =>
    applyProjected(c, addPositionIsPitcher ?? c.isPitcher)
  );

  dropSuggestions = dropSuggestions.map((drop) => {
    if (!drop.playerKey) return drop;
    const isPitcher = !!drop.isPitcher;
    const zContext = isPitcher ? pitcherZ : hitterZ;
    const projected = computeProjectedZScore({
      playerKey: drop.playerKey,
      isPitcher,
      statKeys: isPitcher ? pitchingStatKeys : battingStatKeys,
      statIdByKey,
      currentSeasonStatsByKey,
      historyByKey,
      abStatId,
      ipStatId,
      zContext,
    });
    return {
      ...drop,
      statsScore:
        projected !== null && projected !== undefined ? projected : drop.statsScore,
    };
  });
  dropDiagnostics = {
    ...dropDiagnostics,
    safeDropCandidates: dropSuggestions.length,
  };

  // Rebuild queues now that drop suggestions may have history-informed statsScore.
  dropHittersQueue = dropSuggestions
    .filter((drop) => !drop.isPitcher)
    .map((d) => ({ ...d }));
  dropPitchersQueue = dropSuggestions
    .filter((drop) => drop.isPitcher)
    .map((d) => ({ ...d }));
  const dropByName = new Map(dropSuggestions.map((drop) => [drop.name, drop]));

  let addPrintedCount = 0;
  const printAddCandidates = (label, candidates, isPitcher) => {
    if (!candidates || candidates.length === 0) return;
    if (!label) return;
    const ordered = [...candidates].sort((a, b) => {
      const aFit = a.archetypeFitScore ?? 0;
      const bFit = b.archetypeFitScore ?? 0;
      if (aFit !== bFit) return bFit - aFit;
      const aScore = a.statsScore ?? Number.NEGATIVE_INFINITY;
      const bScore = b.statsScore ?? Number.NEGATIVE_INFINITY;
      if (aScore === bScore) return 0;
      return bScore - aScore;
    });
    const eligible = ordered
      .map((item) => {
        const allowCrossTypeForSaves =
          savesEmergency &&
          needsSaves &&
          isPitcher === true &&
          item?.positions?.includes("RP");
        const dropName = allowCrossTypeForSaves
          ? takeAnyDropName()
          : isPitcher === null
            ? findMatchingDropGeneral(item)
            : findMatchingDrop(item, isPitcher);
        return { item, dropName };
      })
      .filter((pair) => pair.dropName);
    if (eligible.length === 0) {
      return;
    }
    printActionsHeader();
    console.log(cYellow(label));
    eligible.forEach(({ item, dropName }) => {
      const position = item.positions.join(", ");
      const tag = item.archetype ? ` [${item.archetype}]` : "";
      console.log(
        fmtBullet(
          `${item.name}${tag} ${position ? `(${position})` : ""} -> drop ${dropName}`.trim()
        )
      );
      addPrintedCount += 1;
      const detail = {
        action: "ADD",
        playerName: item.name,
        playerKey: item.playerKey || null,
        positions: item.positions || [],
        pairedDrop: dropName,
        pairedDropReason: dropByName.get(dropName)?.reason || null,
        targetCategories: item.isPitcher ? pitchingStatKeys : battingStatKeys,
        archetype: item.archetype || null,
        archetypeFitScore: item.archetypeFitScore ?? null,
        statsScore: item.statsScore ?? null,
        yahooRank: item.rank ?? null,
        why: `Targets ${((item.isPitcher ? pitchingStatKeys : battingStatKeys) || []).join(", ")}; ${item.archetype ? `${item.archetype} archetype; ` : ""}paired with ${dropName} for a net roster move.`,
      };
      if (isPitcher === null) {
        actionSuggestions.add.push(item.name);
        actionDetails.add.push(detail);
      } else if (isPitcher) {
        actionSuggestions.addPitching.push(item.name);
        actionDetails.addPitching.push(detail);
      } else {
        actionSuggestions.addBatting.push(item.name);
        actionDetails.addBatting.push(detail);
      }
    });
  };
  const protectedReviewLine = (state) => {
    const status = state.status ? `${state.status}` : "IL";
    if (state.reviewStatus === "eligible") {
      return `${state.name}: protected ${status}, reviewed ${state.reviewedAt}; eligible only because review says >30 days.`;
    }
    if (state.reviewStatus === "stale") {
      return `${state.name}: protected ${status}, injury review is stale (${state.reviewAgeDays} days old; max ${state.maxAgeDays}).`;
    }
    if (state.reviewStatus === "not_out_beyond_30") {
      return `${state.name}: protected ${status}, review does not support >30 days out.`;
    }
    if (state.reviewStatus === "incomplete") {
      return `${state.name}: protected ${status}, review is incomplete.`;
    }
    return `${state.name}: protected ${status}, no qualifying >30-day injury review.`;
  };

  if (savesEmergency) {
    // When we're at/near zero saves, spend our limited drop slots on RP adds first.
    printAddCandidates(addPitchingLabel, addPitchingCandidates, true);
    printAddCandidates(addBattingLabel, addBattingCandidates, false);
  } else {
    printAddCandidates(addBattingLabel, addBattingCandidates, false);
    printAddCandidates(addPitchingLabel, addPitchingCandidates, true);
  }
  printAddCandidates(addGeneralLabel, addGeneralCandidates, null);
  printAddCandidates(addPositionLabel, addPositionCandidates, addPositionIsPitcher);
  if (
    addPrintedCount === 0 &&
    (addBattingCandidates.length > 0 ||
      addPitchingCandidates.length > 0 ||
      addGeneralCandidates.length > 0 ||
      addPositionCandidates.length > 0)
  ) {
    printActionsHeader();
    if (dropDiagnostics.safeDropCandidates === 0) {
      dropDiagnostics = {
        ...dropDiagnostics,
        noAddReason: "No safe drop candidates after protections.",
      };
      console.log(
        cYellow("ADD:") +
          " " +
          fmtLine(
            `none (${dropDiagnostics.addCandidateCount} add candidates, 0 safe drop candidates after protections).`
          )
      );
      if (dropDiagnostics.blockedProtectedDrops.length > 0) {
        console.log(cYellow("Protected IL checks:"));
        dropDiagnostics.blockedProtectedDrops.slice(0, 5).forEach((state) => {
          console.log(fmtBullet(protectedReviewLine(state)));
        });
      }
    } else {
      dropDiagnostics = {
        ...dropDiagnostics,
        noAddReason: "Safe drops exist, but no add cleared upgrade thresholds.",
      };
      console.log(
        cYellow("ADD:") +
          " " +
          fmtLine(
            `none (${dropDiagnostics.safeDropCandidates} safe drops exist, but no add cleared rank/stat upgrade thresholds).`
          )
      );
    }
  }
  if (dropDiagnostics.staleProtectedInjuryReviews.length > 0) {
    printActionsHeader();
    console.log(cYellow("Injury review warning:"));
    dropDiagnostics.staleProtectedInjuryReviews.slice(0, 5).forEach((state) => {
      console.log(fmtBullet(protectedReviewLine(state)));
    });
  }

  if (startSelections.length > 0) {
    printActionsHeader();
    console.log(cYellow(startLabel));
    const plans = startPlans && startPlans.length > 0 ? startPlans : startSelections.map((p) => ({ name: p.name, startSlot: null, benchName: null, benchSlot: null, note: null, positions: p.positions }));
    plans.forEach((plan, idx) => {
      const base = startSelections[idx];
      const position = base?.positions?.join(", ") || "";
      const slotText = plan.startSlot ? ` at ${plan.startSlot}` : "";
      const benchText =
        plan.benchName && plan.benchSlot
          ? ` -> bench ${plan.benchName} (${plan.benchSlot})`
          : plan.note
            ? ` (${plan.note})`
            : plan.benchName
              ? ` -> bench ${plan.benchName}`
              : "";
      console.log(
        fmtBullet(
          `Start ${plan.name}${slotText} ${position ? `(${position})` : ""}${benchText}${
            base?.startScore !== undefined ? ` [score ${formatStartScore(base.startScore)}]` : ""
          }`.trim()
        )
      );
      actionSuggestions.start.push(plan.name);
      actionDetails.start.push({
        action: "START",
        playerName: plan.name,
        playerKey: plan.playerKey || base?.playerKey || null,
        positions: base?.positions || [],
        startSlot: plan.startSlot || null,
        benchName: plan.benchName || null,
        benchSlot: plan.benchSlot || null,
        score: toNumber(base?.startScore),
        schedule: base?.startSchedule || null,
        reasons: base?.startReasons || [],
        targetCategories: base?.isPitcher ? pitchingStatKeys : battingStatKeys,
        why: plan.note
          ? `Fits ${base?.isPitcher ? "pitching" : "batting"} targets but ${plan.note}.`
          : `Score ${formatStartScore(base?.startScore) || "n/a"}; ${(base?.startReasons || []).slice(0, 3).join("; ") || `fits ${base?.isPitcher ? "pitching" : "batting"} targets`}; start at ${plan.startSlot || "eligible slot"}${plan.benchName ? ` over ${plan.benchName}` : ""}.`,
      });
    });
    console.log(
      fmtLine("Note: apply these swaps manually after Yahoo Start Active Players, or Yahoo may overwrite them.")
    );
  } else if (startMessage) {
    printActionsHeader();
    console.log(fmtLine(startMessage));
  }

  if (dropHeader && dropLines.length > 0) {
    printActionsHeader();
    console.log(cYellow(dropHeader));
    dropLines.forEach((line, idx) => {
      const trimmed = line.startsWith("- ") ? line.slice(2) : line;
      console.log(fmtBullet(trimmed));
      if (dropSuggestions[idx]) {
        actionSuggestions.drop.push(dropSuggestions[idx].name);
        actionDetails.drop.push({
          action: "DROP",
          playerName: dropSuggestions[idx].name,
          playerKey: dropSuggestions[idx].playerKey || null,
          positions: dropSuggestions[idx].positions || [],
          status: dropSuggestions[idx].status || null,
          yahooRank: dropSuggestions[idx].rank ?? null,
          statsScore: dropSuggestions[idx].statsScore ?? null,
          statusDrop: !!dropSuggestions[idx].statusDrop,
          injuryReview: dropSuggestions[idx].injuryReview || null,
          why: dropSuggestions[idx].reason || "Safe drop candidate based on current roster rules.",
        });
      }
    });
  } else if (dropMessage) {
    printActionsHeader();
    console.log(fmtLine(dropMessage));
  }
  console.log("");

  if (positionFilter === "C" && addPositionAllCandidates.length > 0) {
    const rankedCatchers = rankHittersByStats(
      addPositionAllCandidates,
      statIdByKey,
      targetKeys
    );
    console.log(cYellow("Catcher options (live season stats):"));
    rankedCatchers.slice(0, getTopLimit(5)).forEach((candidate, idx) => {
      const statR = statIdByKey.get("R");
      const statHR = statIdByKey.get("HR");
      const statRBI = statIdByKey.get("RBI");
      const statSB = statIdByKey.get("SB");
      const statAVG = statIdByKey.get("AVG");
      const values = {
        R: statR ? candidate.stats?.get(statR) ?? 0 : 0,
        HR: statHR ? candidate.stats?.get(statHR) ?? 0 : 0,
        RBI: statRBI ? candidate.stats?.get(statRBI) ?? 0 : 0,
        SB: statSB ? candidate.stats?.get(statSB) ?? 0 : 0,
        AVG: statAVG ? candidate.stats?.get(statAVG) ?? 0 : 0,
      };
      console.log(
        fmtLine(
          `${idx + 1}. ${candidate.name} (${candidate.positions.join(", ")}) - R ${values.R}, HR ${values.HR}, RBI ${values.RBI}, SB ${values.SB}, AVG ${values.AVG}`
        )
      );
    });
    console.log("");
  }

  const featureInputs = buildSnapshotFeatures({
    leagueSettingsFile,
    resolvedCategories,
    focusKeys,
    targetModel,
    startContext,
    startDiagnostics,
    pointInfoByKey,
    categoryNextGaps,
    rosterMappedPlayers,
    startPlans,
    actionSuggestions,
    actionDetails,
    dropSuggestions,
    addCandidates: allAddCandidates,
    dropDiagnostics,
  });

  await finalizeAndLogRun({
    config,
    overallRank,
    seasonProgress,
    gpValue,
    ipValue,
    gpCap,
    ipCap,
    resolvedCategories,
    targetKeys,
    bestValueTargets,
    focusKeys,
    pointsToNextTeam,
    categoryNextGaps,
    leagueStandings,
    actionSuggestions,
    actionDetails,
    rosterState,
    learning,
    featureInputs,
  });
}

async function logActionsEntry({ adds, drops, starts, benches, notes }) {
  const snapshots = readJsonl(SNAPSHOT_LOG);
  if (snapshots.length === 0) {
    throw new Error("No snapshots found. Run recommend first.");
  }
  const lastSnapshot = snapshots[snapshots.length - 1];
  const actionEntry = {
    id: new Date().toISOString(),
    date: todayDateString(),
    snapshotId: lastSnapshot.id,
    adds,
    drops,
    starts,
    benches,
    notes: notes || "",
  };
  appendJsonl(ACTION_LOG, actionEntry);
  await writeActionLogToDb(actionEntry);
  console.log("Logged actions for last recommendation.");
}

async function logActions() {
  const adds = getListArg("--add");
  const drops = getListArg("--drop");
  const starts = getListArg("--start");
  const benches = getListArg("--bench");
  const notes = getArgValue("--notes");
  await logActionsEntry({ adds, drops, starts, benches, notes });
}

function addDaysLocalDateString(baseDateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(baseDateStr || "").trim());
  if (!m) return baseDateStr;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function renderLineup({ dateStr, rosterPayload, playerFilter = [] }) {
  const payloadDate = findFirstValueByKey(rosterPayload, "date");
  const players = findAllValuesByKey(rosterPayload, "player");
  const filterSet = new Set(
    (playerFilter || []).map((name) => name.trim().toLowerCase()).filter(Boolean)
  );
  const mapped = players
    .map((player) => {
      const name = extractPlayerName(player);
      const positions = extractPlayerPositions(player);
      const selected = extractSelectedPositions(player);
      const status = extractPlayerStatus(player);
      return {
        name,
        positions,
        selected,
        selectedPrimary: extractPrimarySelectedPosition(selected),
        status,
        isPitcher: isPitcherPositions(positions),
        isIL: isILPosition(selected) || isILStatus(status),
      };
    })
    .filter((p) => p.name)
    .filter((p) => filterSet.size === 0 || filterSet.has(p.name.toLowerCase()));

  const slotOrder = [
    "C",
    "1B",
    "2B",
    "3B",
    "SS",
    "OF",
    "UTIL",
    "SP",
    "RP",
    "P",
    "BN",
    "IL",
  ];
  const bySlot = new Map();
  mapped.forEach((p) => {
    const slot = normalizeSlot(p.selectedPrimary) || "UNK";
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(p);
  });

  const title = payloadDate && payloadDate !== dateStr ? `${dateStr} (API date ${payloadDate})` : dateStr;
  console.log(cYellow(`Lineup ${title}:`));

  const printGroup = (label, slots) => {
    const out = [];
    slots.forEach((slot) => {
      const list = bySlot.get(slot) || [];
      list.forEach((p) => out.push({ slot, p }));
    });
    if (out.length === 0) return;
    console.log(fmtLine(label));
    out.forEach(({ slot, p }) => {
      const pos = (p.positions || []).join(", ");
      const status = p.status ? ` ${p.status}` : "";
      console.log(fmtBullet(`${slot}: ${p.name}${status}${pos ? ` (${pos})` : ""}`.trim()));
    });
  };

  printGroup("Active:", slotOrder.filter((s) => !["BN", "IL"].includes(s)));
  printGroup("Bench/IL:", ["BN", "IL"]);

  const unknown = [...bySlot.keys()].filter((k) => !slotOrder.includes(k));
  if (unknown.length > 0) {
    console.log(fmtLine("Other:"));
    unknown.forEach((slot) => {
      (bySlot.get(slot) || []).forEach((p) => {
        const pos = (p.positions || []).join(", ");
        console.log(fmtBullet(`${slot}: ${p.name}${pos ? ` (${pos})` : ""}`.trim()));
      });
    });
  }
  console.log("");
}

async function lineup() {
  const config = loadConfig();
  const accessToken = await getAccessToken(config);
  if (!config.teamKey) throw new Error("Missing teamKey. Run: node fantasy/cli.js discover");

  const dateArg = getArgValue("--date");
  const playerFilter = [
    ...getListArg("--player"),
    ...getListArg("--players"),
  ];
  const today = todayDateString();
  const tomorrow = addDaysLocalDateString(today, 1);

  const dates = dateArg ? [dateArg] : [today, tomorrow];
  for (const dateStr of dates) {
    const roster = await fetchRosterForDate({
      accessToken,
      teamKey: config.teamKey,
      dateStr,
    });
    renderLineup({ dateStr, rosterPayload: roster, playerFilter });
  }
}

function flattenActionDetails(snapshot) {
  const details = snapshot?.actionDetails || {};
  const actions = snapshot?.actions || {};
  const rows = [];
  const addRow = (type, detail, idx) => {
    rows.push({
      type,
      idx,
      playerName: detail?.playerName || detail?.name || null,
      detail: detail || {},
    });
  };

  ["addBatting", "addPitching", "add", "start", "drop"].forEach((type) => {
    const typeDetails = Array.isArray(details[type]) ? details[type] : [];
    const names = Array.isArray(actions[type]) ? actions[type] : [];
    if (typeDetails.length > 0) {
      typeDetails.forEach((detail, idx) => addRow(type, detail, idx));
      return;
    }
    names.forEach((name, idx) => addRow(type, { playerName: name, why: "No detailed explanation stored for this older run." }, idx));
  });
  return rows;
}

function actionTypeLabel(type) {
  if (type === "addBatting" || type === "addPitching" || type === "add") return "ADD";
  if (type === "start") return "START";
  if (type === "drop") return "DROP";
  return type.toUpperCase();
}

function reviewCard(row) {
  const d = row.detail || {};
  const label = actionTypeLabel(row.type);
  const parts = [];
  if (label === "ADD" && d.pairedDrop) parts.push(`Drop ${d.pairedDrop}`);
  if (label === "START" && d.startSlot) parts.push(`Start at ${d.startSlot}`);
  if (label === "START" && d.benchName) parts.push(`Bench ${d.benchName}${d.benchSlot ? ` (${d.benchSlot})` : ""}`);
  if (label === "DROP" && d.status) parts.push(`Status ${d.status}`);
  if (d.targetCategories?.length) parts.push(`Targets ${d.targetCategories.join(", ")}`);
  if (d.archetype) parts.push(`Archetype ${d.archetype}`);
  if (d.yahooRank !== null && d.yahooRank !== undefined) parts.push(`Yahoo rank ${d.yahooRank}`);
  if (d.statsScore !== null && d.statsScore !== undefined) parts.push(`Score ${formatMaybeNumber(d.statsScore)}`);

  return `
    <article class="item">
      <div class="pill">${escapeHtml(label)}</div>
      <h2>${escapeHtml(d.playerName || row.playerName || "Unknown")}</h2>
      ${parts.length > 0 ? `<div class="sub">${parts.map(escapeHtml).join(" · ")}</div>` : ""}
      <p>${escapeHtml(d.why || "No explanation stored.")}</p>
      ${d.pairedDropReason ? `<p class="muted">Drop reason: ${escapeHtml(d.pairedDropReason)}</p>` : ""}
    </article>
  `;
}

async function review() {
  const snapshot = await latestSnapshotFromDb();
  if (!snapshot) {
    console.log("No recommendations found. Run recommend first.");
    return;
  }
  const rows = flattenActionDetails(snapshot);
  const outPath = path.join(LOG_DIR, "decision-review.html");
  const targetSummary = (snapshot.focusTargets || snapshot.targets || []).join(", ") || "none";
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fantasy Decision Review</title>
  <style>
    :root { --bg:#f7f7f4; --ink:#172019; --muted:#5c655e; --line:#d7ddd4; --card:#ffffff; --accent:#1f7a4d; --warn:#9f6a00; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family: Avenir Next, Verdana, sans-serif; }
    main { max-width: 980px; margin: 24px auto 48px; padding: 0 16px; }
    header { border-bottom:1px solid var(--line); padding-bottom:14px; margin-bottom:16px; }
    h1 { font-size: 24px; margin:0 0 6px; }
    .meta { color:var(--muted); font-size:13px; }
    .notice { border:1px solid #d9c48f; background:#fff8df; color:#4b3500; padding:10px 12px; border-radius:6px; margin: 14px 0; }
    .grid { display:grid; grid-template-columns:1fr; gap:10px; }
    @media (min-width: 760px) { .grid { grid-template-columns:1fr 1fr; } }
    .item { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; }
    .pill { display:inline-block; font-size:11px; font-weight:700; color:white; background:var(--accent); border-radius:999px; padding:3px 8px; margin-bottom:8px; }
    h2 { font-size:18px; margin:0 0 6px; }
    p { margin:8px 0 0; line-height:1.4; }
    .sub, .muted { color:var(--muted); font-size:13px; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Decision Review</h1>
      <div class="meta">${escapeHtml(snapshot.date)} · ${escapeHtml(snapshot.leagueName || snapshot.leagueKey)} · ${escapeHtml(snapshot.teamName || snapshot.teamKey)} · rank ${escapeHtml(snapshot.overallRank)}</div>
      <div class="meta">Focus targets: ${escapeHtml(targetSummary)}</div>
    </header>
    <div class="notice">Apply Yahoo Start Active Players first, then make these swaps manually. Clicking it again can overwrite the swaps.</div>
    <section class="grid">
      ${rows.length > 0 ? rows.map(reviewCard).join("\n") : "<p>No action recommendations in the latest snapshot.</p>"}
    </section>
  </main>
</body>
</html>`;
  ensureLogDir();
  fs.writeFileSync(outPath, html);
  console.log(`Decision review: ${outPath}`);
  if (shouldOpenDashboard()) openDashboardFile(outPath);
}

function parseAppLimit(raw, fallback = 90) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 365);
}

function parseAppPort(raw, fallback = 8787) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 65535);
}

async function appSnapshots(limit = 90) {
  try {
    const db = await getDb();
    const rows = db
      .prepare("SELECT raw_json FROM snapshots ORDER BY timestamp DESC LIMIT ?")
      .all(limit);
    return rows
      .map((row) => {
        try {
          return JSON.parse(row.raw_json);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return readJsonl(SNAPSHOT_LOG).slice(-limit);
  }
}

function appLatestByDate(snapshots) {
  const byDate = new Map();
  (snapshots || []).forEach((snapshot) => {
    const key = snapshot?.date || snapshot?.timestamp || snapshot?.id;
    if (key) byDate.set(key, snapshot);
  });
  return [...byDate.values()];
}

function appTotalPoints(snapshot) {
  return (snapshot?.categories || []).reduce((sum, cat) => {
    const points = toNumber(cat.points);
    return sum + (points ?? 0);
  }, 0);
}

function appCategoryMap(snapshot) {
  const out = {};
  (snapshot?.categories || []).forEach((cat) => {
    out[cat.key] = {
      key: cat.key,
      name: cat.name || cat.key,
      value: cat.value,
      points: cat.points,
      rank: cat.rank,
    };
  });
  return out;
}

function appSnapshotSummary(snapshot) {
  const ptn = snapshot?.pointsToNextTeam || {};
  return {
    id: snapshot?.id || null,
    date: snapshot?.date || null,
    timestamp: snapshot?.timestamp || snapshot?.id || null,
    leagueName: snapshot?.leagueName || snapshot?.leagueKey || null,
    teamName: snapshot?.teamName || snapshot?.teamKey || null,
    overallRank: snapshot?.overallRank ?? null,
    seasonProgress: snapshot?.seasonProgress ?? null,
    gpValue: snapshot?.gpValue ?? null,
    gpCap: snapshot?.gpCap ?? null,
    ipValue: snapshot?.ipValue ?? null,
    ipCap: snapshot?.ipCap ?? null,
    totalPoints: appTotalPoints(snapshot),
    pointsToNextTeam: ptn,
    targets: snapshot?.focusTargets || snapshot?.targets || [],
    bestValueTargets: snapshot?.bestValueTargets || [],
    categories: appCategoryMap(snapshot),
  };
}

function appLineupFromSnapshot(snapshot) {
  const groups = { active: [], bench: [], il: [], other: [] };
  const slotOrder = [
    "C",
    "1B",
    "2B",
    "3B",
    "SS",
    "CI",
    "MI",
    "OF",
    "Util",
    "SP",
    "RP",
    "P",
    "BN",
    "IL",
  ];
  const slotRank = new Map(slotOrder.map((slot, idx) => [slot.toUpperCase(), idx]));
  (snapshot?.roster || []).forEach((player) => {
    const selected = Array.isArray(player.selected) ? player.selected : [];
    const slot = player.selectedPrimary || selected[0] || "?";
    const row = {
      name: player.name,
      slot,
      selected,
      positions: player.positions || [],
      status: player.status || null,
    };
    const slotUpper = String(slot).toUpperCase();
    const statusUpper = String(player.status || "").toUpperCase();
    if (slotUpper === "IL" || statusUpper === "IL") {
      groups.il.push(row);
    } else if (slotUpper === "BN" || slotUpper === "BE") {
      groups.bench.push(row);
    } else if (slotRank.has(slotUpper)) {
      groups.active.push(row);
    } else {
      groups.other.push(row);
    }
  });
  const sortBySlot = (a, b) => {
    const aRank = slotRank.get(String(a.slot).toUpperCase()) ?? 999;
    const bRank = slotRank.get(String(b.slot).toUpperCase()) ?? 999;
    return aRank - bRank || String(a.name || "").localeCompare(String(b.name || ""));
  };
  Object.values(groups).forEach((items) => items.sort(sortBySlot));
  return groups;
}

async function appLatestPayload() {
  const snapshots = await appSnapshots(90);
  const snapshot = snapshots[snapshots.length - 1] || (await latestSnapshotFromDb());
  return {
    generatedAt: new Date().toISOString(),
    source: fs.existsSync(DB_PATH) ? "sqlite" : "jsonl",
    summary: appSnapshotSummary(snapshot),
    snapshot,
    recommendations: flattenActionDetails(snapshot),
    effectiveness: buildEffectivenessSummary(snapshots, snapshot) || [],
  };
}

async function appSnapshotsPayload(url) {
  const limit = parseAppLimit(url.searchParams.get("limit"), 90);
  const daily = url.searchParams.get("daily") !== "0";
  const snapshots = await appSnapshots(limit);
  const selected = daily ? appLatestByDate(snapshots) : snapshots;
  return {
    count: selected.length,
    snapshots: selected.map(appSnapshotSummary),
  };
}

async function appRecommendationsPayload(url) {
  const limit = parseAppLimit(url.searchParams.get("limit"), 20);
  const snapshots = await appSnapshots(limit);
  const rows = snapshots.flatMap((snapshot) =>
    flattenActionDetails(snapshot).map((row) => ({
      snapshotId: snapshot.id,
      date: snapshot.date,
      type: actionTypeLabel(row.type),
      playerName: row.playerName,
      detail: row.detail,
    }))
  );
  return {
    count: rows.length,
    recommendations: rows,
  };
}

async function appLineupPayload() {
  const snapshot = await latestSnapshotFromDb();
  return {
    date: snapshot?.date || null,
    snapshotId: snapshot?.id || null,
    lineup: appLineupFromSnapshot(snapshot),
  };
}

async function appEffectivenessPayload() {
  const snapshots = await appSnapshots(60);
  const daily = appLatestByDate(snapshots);
  const latest = daily[daily.length - 1] || snapshots[snapshots.length - 1] || null;
  const rows = [];
  for (let i = 1; i < daily.length; i += 1) {
    const prev = daily[i - 1];
    const curr = daily[i];
    const adherence = computeStartAdherence(prev, curr);
    rows.push({
      fromDate: prev.date,
      toDate: curr.date,
      rankBefore: prev.overallRank,
      rankAfter: curr.overallRank,
      rankDelta:
        toNumber(prev.overallRank) !== null && toNumber(curr.overallRank) !== null
          ? toNumber(prev.overallRank) - toNumber(curr.overallRank)
          : null,
      pointsBefore: appTotalPoints(prev),
      pointsAfter: appTotalPoints(curr),
      adherence,
      targets: prev.focusTargets || prev.targets || [],
    });
  }
  return {
    latestSummary: latest ? buildEffectivenessSummary(snapshots, latest) || [] : [],
    rows: rows.slice(-30),
  };
}

async function appRankReviewPayload(url) {
  const limit = parseAppLimit(url.searchParams.get("limit"), 120);
  const days = parseAppLimit(url.searchParams.get("days"), 14);
  const snapshots = await appSnapshots(limit);
  const report = buildRankReview(snapshots, { days });
  return {
    ...report,
    allTransitions: undefined,
  };
}

function sendAppJson(res, payload, status = 200) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendAppHtml(res, html, status = 200) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function appHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fantasy Baseball Control Room</title>
  <style>
    :root {
      --bg: #f4f2ec;
      --panel: #fffdf7;
      --ink: #1d261e;
      --muted: #687063;
      --line: #d9d4c7;
      --green: #5a9b50;
      --brown: #9a6a16;
      --blue: #617dff;
      --red: #a84532;
      --shadow: 0 18px 40px rgba(60, 48, 24, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(90,155,80,0.16), transparent 32rem),
        linear-gradient(135deg, #f8f7f2, var(--bg));
      color: var(--ink);
      font-family: "Avenir Next", "Trebuchet MS", Verdana, sans-serif;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 28px 18px 48px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 18px; }
    h1 { margin: 0 0 6px; font-size: clamp(26px, 4vw, 44px); letter-spacing: -0.04em; color: var(--green); }
    .meta { color: var(--muted); font-size: 14px; }
    .refresh { border: 1px solid var(--line); background: var(--panel); color: var(--brown); border-radius: 999px; padding: 9px 14px; font-weight: 700; cursor: pointer; }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 18px; }
    .tab { border: 1px solid var(--line); background: rgba(255,255,255,0.7); color: var(--muted); border-radius: 999px; padding: 10px 14px; cursor: pointer; font-weight: 700; }
    .tab.active { background: var(--ink); color: white; border-color: var(--ink); }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 12px; }
    .card { grid-column: span 12; background: rgba(255,253,247,0.92); border: 1px solid var(--line); border-radius: 18px; padding: 16px; box-shadow: var(--shadow); }
    @media (min-width: 760px) { .half { grid-column: span 6; } .third { grid-column: span 4; } .two { grid-column: span 8; } }
    h2 { margin: 0 0 10px; font-size: 18px; color: var(--brown); }
    h3 { margin: 0 0 6px; font-size: 15px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: 6px 0; border-top: 1px solid rgba(217,212,199,0.65); }
    li:first-child { border-top: 0; }
    .big { font-size: 28px; font-weight: 800; color: var(--green); }
    .pill { display: inline-block; color: white; background: var(--green); border-radius: 999px; padding: 3px 8px; font-size: 11px; font-weight: 800; margin-right: 6px; }
    .pill.start { background: var(--blue); }
    .pill.drop { background: var(--red); }
    .sub { color: var(--muted); font-size: 13px; line-height: 1.35; }
    .empty { color: var(--muted); font-style: italic; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid rgba(217,212,199,0.8); vertical-align: top; }
    th { color: var(--brown); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .hidden { display: none; }
    .chart { width: 100%; height: 220px; border: 1px dashed var(--line); border-radius: 14px; background: rgba(255,255,255,0.46); }
    .mono { font-family: Menlo, Monaco, Consolas, monospace; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Fantasy Control Room</h1>
        <div class="meta" id="top-meta">Loading SQLite-backed dashboard...</div>
      </div>
      <button class="refresh" id="refresh">Refresh</button>
    </header>
    <nav class="tabs">
      <button class="tab active" data-tab="today">Today</button>
      <button class="tab" data-tab="review">Review</button>
      <button class="tab" data-tab="lineup">Lineup</button>
      <button class="tab" data-tab="trends">Trends</button>
      <button class="tab" data-tab="history">History</button>
    </nav>

    <section id="today" class="page grid"></section>
    <section id="review" class="page grid hidden"></section>
    <section id="lineup" class="page grid hidden"></section>
    <section id="trends" class="page grid hidden"></section>
    <section id="history" class="page grid hidden"></section>
  </main>
  <script>
    const state = {};
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    async function getJson(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(path + " failed: " + res.status);
      return res.json();
    }
    function fmt(value, digits = 1) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "n/a";
      return Number.isInteger(n) ? String(n) : n.toFixed(digits);
    }
    function actionLabel(row) {
      return String(row.type || "").replace("addBatting", "ADD").replace("addPitching", "ADD").replace("add", "ADD").replace("start", "START").replace("drop", "DROP").toUpperCase();
    }
    function actionClass(label) {
      if (label === "START") return "start";
      if (label === "DROP") return "drop";
      return "";
    }
    function actionSub(row) {
      const d = row.detail || {};
      const bits = [];
      if (d.pairedDrop) bits.push("drop " + d.pairedDrop);
      if (d.startSlot) bits.push("start at " + d.startSlot);
      if (d.benchName) bits.push("bench " + d.benchName + (d.benchSlot ? " (" + d.benchSlot + ")" : ""));
      if (d.targetCategories && d.targetCategories.length) bits.push("targets " + d.targetCategories.join(", "));
      if (d.confidence) bits.push("confidence " + d.confidence);
      return bits.join(" · ");
    }
    function renderToday() {
      const s = state.latest.summary || {};
      const cats = s.categories || {};
      const actions = state.latest.recommendations || [];
      const targetItems = (s.targets || []).map((key) => {
        const c = cats[key] || { name: key };
        return "<li><strong>" + esc(key) + "</strong> <span class='sub'>" + esc(c.name) + " · points " + esc(fmt(c.points)) + " · rank " + esc(fmt(c.rank, 0)) + "</span></li>";
      }).join("") || "<li class='empty'>No target categories stored yet.</li>";
      const actionItems = actions.map((row) => {
        const label = actionLabel(row);
        return "<li><span class='pill " + actionClass(label) + "'>" + esc(label) + "</span><strong>" + esc(row.playerName || row.detail?.playerName || "Unknown") + "</strong><div class='sub'>" + esc(actionSub(row) || row.detail?.why || "") + "</div></li>";
      }).join("") || "<li class='empty'>No recommendations yet. Run node cli.js recommend.</li>";
      document.querySelector("#today").innerHTML =
        "<article class='card third'><h2>Rank</h2><div class='big'>" + esc(s.overallRank ?? "n/a") + "</div><div class='sub'>Season " + esc(fmt((s.seasonProgress || 0) * 100, 0)) + "% · IP " + esc(fmt(s.ipValue, 1)) + "/" + esc(s.ipCap ?? "n/a") + "</div></article>" +
        "<article class='card third'><h2>Points To Next</h2><div class='big'>" + esc(s.pointsToNextTeam?.delta ? "+" + fmt(s.pointsToNextTeam.delta, 1) : "n/a") + "</div><div class='sub'>" + esc(s.pointsToNextTeam?.nextTeamName || "No team gap stored") + "</div></article>" +
        "<article class='card third'><h2>Total Points</h2><div class='big'>" + esc(fmt(s.totalPoints, 1)) + "</div><div class='sub'>Across roto categories</div></article>" +
        "<article class='card half'><h2>Targets</h2><ul>" + targetItems + "</ul></article>" +
        "<article class='card half'><h2>Actions</h2><ul>" + actionItems + "</ul></article>";
    }
    function renderReview() {
      const rows = state.latest.recommendations || [];
      const cards = rows.map((row) => {
        const label = actionLabel(row);
        const why = row.detail?.why || "No explanation stored.";
        return "<article class='card half'><span class='pill " + actionClass(label) + "'>" + esc(label) + "</span><h2>" + esc(row.playerName || row.detail?.playerName || "Unknown") + "</h2><div class='sub'>" + esc(actionSub(row)) + "</div><p>" + esc(why) + "</p></article>";
      }).join("") || "<article class='card'><p class='empty'>No decision details available.</p></article>";
      document.querySelector("#review").innerHTML = cards;
    }
    function lineupTable(title, rows) {
      const body = (rows || []).map((p) => "<tr><td class='mono'>" + esc(p.slot) + "</td><td>" + esc(p.name) + "</td><td>" + esc((p.positions || []).join(", ")) + "</td><td>" + esc(p.status || "") + "</td></tr>").join("") || "<tr><td colspan='4' class='empty'>None</td></tr>";
      return "<article class='card half'><h2>" + esc(title) + "</h2><table><thead><tr><th>Slot</th><th>Player</th><th>Eligible</th><th>Status</th></tr></thead><tbody>" + body + "</tbody></table></article>";
    }
    function renderLineup() {
      const l = state.lineup.lineup || {};
      document.querySelector("#lineup").innerHTML =
        lineupTable("Active", l.active) + lineupTable("Bench", l.bench) + lineupTable("IL", l.il) + lineupTable("Other", l.other);
    }
    function drawChart(points, key) {
      if (!points.length) return "<div class='chart'></div>";
      const width = 760, height = 220, pad = 24;
      const vals = points.map((p) => Number(p[key])).filter(Number.isFinite);
      if (!vals.length) return "<div class='chart'></div>";
      const min = Math.min(...vals), max = Math.max(...vals);
      const span = max - min || 1;
      const line = points.map((p, i) => {
        const x = pad + (i * (width - pad * 2)) / Math.max(points.length - 1, 1);
        const y = height - pad - ((Number(p[key]) - min) / span) * (height - pad * 2);
        return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      }).join(" ");
      return "<svg class='chart' viewBox='0 0 " + width + " " + height + "'><path d='" + line + "' fill='none' stroke='#5a9b50' stroke-width='4' stroke-linecap='round'/><text x='18' y='24' fill='#687063' font-size='13'>" + esc(key) + ": " + esc(fmt(vals[vals.length - 1], 1)) + "</text></svg>";
    }
    function renderTrends() {
      const rows = state.snapshots.snapshots || [];
      const rank = state.rankReview || {};
      const latest = rank.latestTransition || {};
      const recItems = (rank.recommendations || []).map((rec) => "<li><strong>" + esc(String(rec.priority || "").toUpperCase()) + ":</strong> " + esc(rec.title || "") + "<div class='sub'>" + esc(rec.detail || "") + "</div></li>").join("") || "<li class='empty'>No rank attribution recommendations yet.</li>";
      const oppItems = (rank.opportunityMatrix || []).slice(0, 5).map((row) => "<li><strong>" + esc(row.key) + "</strong> <span class='sub'>score " + esc(fmt(row.opportunityScore, 1)) + " · points " + esc(fmt(row.points, 1)) + " · next gain " + esc(fmt(row.pointsGainToNext, 1)) + (row.versusNextTeamAbove ? " · direct next-team gap" : "") + "</span></li>").join("") || "<li class='empty'>No opportunity matrix available.</li>";
      document.querySelector("#trends").innerHTML =
        "<article class='card half'><h2>Rank Trend</h2>" + drawChart(rows, "overallRank") + "</article>" +
        "<article class='card half'><h2>Points Trend</h2>" + drawChart(rows, "totalPoints") + "</article>" +
        "<article class='card half'><h2>Rank Attribution</h2><ul>" +
          "<li>Gap closed over window: " + esc(fmt(rank.summary?.totalGapClosed, 1)) + "</li>" +
          "<li>Our point movement: " + esc(fmt(rank.summary?.totalMyPointDelta, 1)) + "</li>" +
          "<li>Latest target point delta: " + esc(fmt(latest.targetPointDelta, 1)) + "</li>" +
          "<li>Blocked add/drop days: " + esc(rank.summary?.blockedDays ?? "n/a") + "</li>" +
        "</ul></article>" +
        "<article class='card half'><h2>Rank Recommendations</h2><ul>" + recItems + "</ul></article>" +
        "<article class='card half'><h2>Opportunity Matrix</h2><ul>" + oppItems + "</ul></article>" +
        "<article class='card half'><h2>Effectiveness</h2><ul>" + ((state.effectiveness.latestSummary || []).map((line) => "<li>" + esc(line.replace(/^- /, "")) + "</li>").join("") || "<li class='empty'>No prior daily comparison yet.</li>") + "</ul></article>";
    }
    function renderHistory() {
      const rows = (state.snapshots.snapshots || []).slice(-30).reverse();
      const body = rows.map((s) => "<tr><td>" + esc(s.date) + "</td><td>" + esc(s.overallRank ?? "") + "</td><td>" + esc(fmt(s.totalPoints, 1)) + "</td><td>" + esc(s.pointsToNextTeam?.delta ? "+" + fmt(s.pointsToNextTeam.delta, 1) : "") + "</td><td>" + esc((s.targets || []).join(", ")) + "</td></tr>").join("");
      document.querySelector("#history").innerHTML =
        "<article class='card'><h2>Snapshot History</h2><table><thead><tr><th>Date</th><th>Rank</th><th>Points</th><th>Next Team</th><th>Targets</th></tr></thead><tbody>" + body + "</tbody></table></article>";
    }
    function renderAll() {
      const s = state.latest.summary || {};
      document.querySelector("#top-meta").textContent = (s.leagueName || "League") + " | " + (s.teamName || "Team") + " | " + (s.date || "") + " | SQLite API";
      renderToday(); renderReview(); renderLineup(); renderTrends(); renderHistory();
    }
    async function loadAll() {
      [state.latest, state.snapshots, state.lineup, state.effectiveness, state.rankReview] = await Promise.all([
        getJson("/api/latest"),
        getJson("/api/snapshots?limit=90&daily=1"),
        getJson("/api/lineup"),
        getJson("/api/effectiveness"),
        getJson("/api/rank-review?days=14"),
      ]);
      renderAll();
    }
    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
        button.classList.add("active");
        document.querySelector("#" + button.dataset.tab).classList.remove("hidden");
      });
    });
    document.querySelector("#refresh").addEventListener("click", loadAll);
    loadAll().catch((error) => {
      document.querySelector("#today").innerHTML = "<article class='card'><h2>Load Error</h2><p>" + esc(error.message) + "</p></article>";
    });
  </script>
</body>
</html>`;
}

async function app() {
  const port = parseAppPort(getArgValue("--port") || process.env.FANTASY_APP_PORT, 8787);
  const host = "127.0.0.1";
  const server = http.createServer((req, res) => {
    (async () => {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      if (url.pathname === "/" || url.pathname === "/app") {
        sendAppHtml(res, appHtml());
        return;
      }
      if (url.pathname === "/api/health") {
        sendAppJson(res, { ok: true, dbPath: DB_PATH, timestamp: new Date().toISOString() });
        return;
      }
      if (url.pathname === "/api/latest") {
        sendAppJson(res, await appLatestPayload());
        return;
      }
      if (url.pathname === "/api/snapshots") {
        sendAppJson(res, await appSnapshotsPayload(url));
        return;
      }
      if (url.pathname === "/api/recommendations") {
        sendAppJson(res, await appRecommendationsPayload(url));
        return;
      }
      if (url.pathname === "/api/lineup") {
        sendAppJson(res, await appLineupPayload());
        return;
      }
      if (url.pathname === "/api/effectiveness") {
        sendAppJson(res, await appEffectivenessPayload());
        return;
      }
      if (url.pathname === "/api/rank-review") {
        sendAppJson(res, await appRankReviewPayload(url));
        return;
      }
      sendAppJson(res, { error: "Not found" }, 404);
    })().catch((error) => {
      sendAppJson(res, { error: error.message }, 500);
    });
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`Fantasy app: ${url}`);
    console.log("API: /api/latest /api/snapshots /api/recommendations /api/lineup /api/effectiveness /api/rank-review");
    if (shouldOpenDashboard()) openDashboardFile(url);
  });
}

async function finalizeAndLogRun({
  config,
  overallRank,
  seasonProgress,
  gpValue,
  ipValue,
  gpCap,
  ipCap,
  resolvedCategories,
  targetKeys,
  bestValueTargets,
  focusKeys,
  pointsToNextTeam,
  categoryNextGaps,
  leagueStandings,
  actionSuggestions,
  actionDetails,
  rosterState,
  learning,
  featureInputs,
}) {
  const snapshot = buildSnapshot({
    config,
    overallRank,
    seasonProgress,
    gpValue,
    ipValue,
    gpCap,
    ipCap,
    resolvedCategories,
    targetKeys,
    bestValueTargets,
    focusKeys,
    pointsToNextTeam,
    categoryNextGaps,
    leagueStandings,
    actionSuggestions,
    actionDetails,
    rosterState,
    featureInputs,
  });

  const snapshotsBefore = readJsonl(SNAPSHOT_LOG);
  const prevSnapshot =
    snapshotsBefore.length > 0 ? snapshotsBefore[snapshotsBefore.length - 1] : null;
  const inferred = prevSnapshot ? inferActions(prevSnapshot, snapshot) : null;
  if (inferred) snapshot.inferredActionsFromPrev = inferred;
  appendJsonl(SNAPSHOT_LOG, snapshot);
  await writeSnapshotToDb(snapshot);

  const actionsLog = readJsonl(ACTION_LOG);
  const snapshotsLog = [...snapshotsBefore, snapshot];

  const effectivenessLines = buildEffectivenessSummary(snapshotsLog, snapshot);
  console.log(cYellow("Effectiveness since prior day:"));
  if (effectivenessLines && effectivenessLines.length > 0) {
    effectivenessLines.forEach((line) => {
      const trimmed = line.startsWith("- ") ? line.slice(2) : line;
      console.log(fmtBullet(trimmed));
    });
  } else {
    console.log(fmtBullet("No prior snapshot to compare."));
  }

  const updatedLearning = evaluateActions({
    learning,
    actions: actionsLog,
    snapshots: snapshotsLog,
    currentSnapshot: snapshot,
  });
  saveLearning(updatedLearning);
  generateDashboardTo(null);

  if (shouldPromptForLog()) {
    const shouldLog = await promptYesNo("Log actions you actually made? (y/n): ");
    if (shouldLog) {
      const adds = await promptList("Adds (comma-separated, blank for none): ");
      const drops = await promptList("Drops (comma-separated, blank for none): ");
      const starts = await promptList("Starts (comma-separated, blank for none): ");
      const benches = await promptList("Benches (comma-separated, blank for none): ");
      const notes = await prompt("Notes (optional): ");
      try {
        await logActionsEntry({ adds, drops, starts, benches, notes });
      } catch (error) {
        console.log(`Log actions failed: ${error.message}`);
      }
    }
  }
}

async function main() {
  const command = process.argv[2];

  try {
    if (command === "auth") {
      await auth();
    } else if (command === "check") {
      await check();
    } else if (command === "cleanup") {
      cleanupDebugFiles();
    } else if (command === "log") {
      await logActions();
    } else if (command === "discover") {
      await discover();
    } else if (command === "dashboard") {
      await dashboard();
    } else if (command === "benchmark") {
      await benchmark();
    } else if (command === "history-backfill") {
      await historyBackfill();
    } else if (command === "app") {
      await app();
    } else if (command === "db-backfill") {
      await backfillDb();
    } else if (command === "review") {
      await review();
    } else if (command === "rank-review") {
      await rankReview();
    } else if (command === "recommend") {
      await recommend();
    } else if (command === "snapshot") {
      await recommend({ snapshotOnly: true });
    } else if (command === "lineup") {
      await lineup();
    } else {
      console.log(
        "Usage: node fantasy/cli.js <auth|check|cleanup|discover|dashboard|benchmark|history-backfill|app|db-backfill|log|recommend|review|rank-review|snapshot|lineup> [--top N] [--position C] [--port 8787] [--verbose]"
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
