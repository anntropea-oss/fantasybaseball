import fs from "fs";
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
const DROP_RANK_FLOOR = 120;
const DROP_RANK_FLOOR_SECONDARY = 80;
const ADD_RANK_IMPROVEMENT = 30;
const ADD_STAT_SCORE_IMPROVEMENT = 0.5;
const EFFECTIVENESS_DELAY_DAYS = 2;
const FREE_AGENT_COUNT = 50;
const FREE_AGENT_COUNT_POSITION = 200;
const FREE_AGENT_COUNT_SAVES = 200;
const PROTECT_TOP_YAHOO_RANK = 30;
const HISTORY_SEASONS = 5;
const HITTER_STABILIZER_AB = 200;
const PITCHER_STABILIZER_IP = 30;
const MAX_HISTORY_KEYS = 80;

const AUTH_AUTHORIZE_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const AUTH_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const FANTASY_API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";

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
      return {
        playerKey,
        name,
        selected,
        selectedPrimary: extractPrimarySelectedPosition(selected),
      };
    })
    .filter(Boolean);
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

async function fetchPlayerStatsByKeys({ accessToken, playerKeys, statTypeOverride = null }) {
  const statTypes = statTypeOverride ? [statTypeOverride] : ["lastmonth", "lastweek", "season"];
  if (!playerKeys || playerKeys.length === 0) {
    return { statsByKey: new Map(), statType: null, hasStats: false };
  }
  const keyParam = encodeURIComponent(playerKeys.join(","));
  for (const statType of statTypes) {
    try {
      const data = await yahooRequest({
        url: `${FANTASY_API_BASE}/players;player_keys=${keyParam}/stats;type=${statType}?format=json`,
        accessToken,
      });
      writeDebugJson(`player-stats-${statType}`, data);
      const statsByKey = new Map();
      const playerNodes = findAllValuesByKey(data, "player");
      playerNodes.forEach((player) => {
        const key = extractPlayerKey(player);
        if (!key) return;
        const stats = extractPlayerStats(player);
        if (stats.size > 0) {
          statsByKey.set(key, stats);
        }
      });
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

function buildStatIdByKey(resolvedCategories) {
  const map = new Map();
  resolvedCategories.forEach((cat) => {
    if (cat.statId) {
      map.set(cat.key, cat.statId);
    }
  });
  return map;
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
  actionSuggestions,
  rosterState,
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
    targets: Array.isArray(targetKeys) ? targetKeys : [],
    focusTargets: Array.isArray(focusKeys) ? focusKeys : [],
    bestValueTargets,
    categories,
    actions: actionSuggestions,
    roster: rosterState || [],
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

function evaluateActions({ learning, actions, snapshots, currentSnapshot }) {
  const safeActions = Array.isArray(actions) ? actions : [];
  const lastEvaluatedId = learning.lastEvaluatedActionId;
  let pending = null;
  for (let i = safeActions.length - 1; i >= 0; i -= 1) {
    const action = safeActions[i];
    if (
      action.id !== lastEvaluatedId &&
      action.snapshotId &&
      action.snapshotId !== currentSnapshot.id
    ) {
      pending = action;
      break;
    }
  }

  let source = "manual";
  if (!pending) {
    const prevSnapshot = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;
    if (
      prevSnapshot &&
      learning.lastEvaluatedSnapshotId !== prevSnapshot.id &&
      prevSnapshot.id !== currentSnapshot.id
    ) {
      pending = inferActions(prevSnapshot, currentSnapshot);
      source = "inferred";
    }
  }
  if (!pending) {
    const prevSnapshot = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;
    if (
      prevSnapshot &&
      learning.lastEvaluatedSnapshotId !== prevSnapshot.id &&
      prevSnapshot.id !== currentSnapshot.id
    ) {
      pending = {
        id: `targets-${currentSnapshot.id}`,
        date: currentSnapshot.date,
        snapshotId: prevSnapshot.id,
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

  const snapshotMap = new Map(snapshots.map((snap) => [snap.id, snap]));
  const baseSnapshot = snapshotMap.get(pending.snapshotId);
  if (!baseSnapshot) return learning;
  if (baseSnapshot.date && currentSnapshot.date) {
    const baseDate = parseIsoDate(baseSnapshot.date);
    const currentDate = parseIsoDate(currentSnapshot.date);
    if (baseDate && currentDate) {
      const diffDays = daysBetweenUtc(baseDate, currentDate);
      if (diffDays < EFFECTIVENESS_DELAY_DAYS) {
        return learning;
      }
    }
  }

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
  const prevSnapshot = snapshots[snapshots.length - 2];
  if (!prevSnapshot || prevSnapshot.id === currentSnapshot.id) return null;

  const lines = [];
  const adherence = computeStartAdherence(prevSnapshot, currentSnapshot);
  if (adherence && adherence.recommendedCount > 0) {
    lines.push(
      `- Lineup adherence: ${adherence.matched}/${adherence.recommendedCount} recommended starts used`
    );
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
  const inferred = inferActions(baseSnapshot, currentSnapshot);
  const actualStarts = new Set(inferred?.starts || []);
  const matched = recommended.filter((name) => actualStarts.has(name)).length;
  const adherence = recommended.length > 0 ? matched / recommended.length : 1;
  return { recommendedCount: recommended.length, matched, adherence };
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

async function recommend() {
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

  const statIdByKey = buildStatIdByKey(resolvedCategories);
  const abStatId = resolveStatIdByAliases(statNameMap, ["At Bats", "AB"]);
  const statIdsForTotals = resolvedCategories
    .map((cat) => cat.statId)
    .filter(Boolean);
  const totalPointsByTeam = computeTotalPoints(teamMetrics, statIdsForTotals);

  const rankedCategories = resolvedCategories
    .filter((stat) => stat.rank !== null && !Number.isNaN(stat.rank))
    .sort((a, b) => b.rank - a.rank);

  const learning = loadLearning();
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
      const deltaText =
        delta === 0 ? "0" : delta > 0 ? `+${delta.toFixed(1)}` : `${delta.toFixed(1)}`;
      console.log(cYellow(`Points to next team: ${deltaText} (${nextTeam.teamName})`));
    } else if (myIndex === 0) {
      console.log(cYellow("Points to next team: leading"));
    }
  }
  console.log("");

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
        pointInfoByKey.set(cat.key, { pointsGain, directionText });
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
    pointGainTargets.length > 0 ? pointGainTargets : worstCategoryKeys;
  targetKeys = [...primaryTargetKeys];
  const focusKeys = [...new Set([...primaryTargetKeys, ...bestValueTargets])];
  const needsSaves = focusKeys.includes("SV");
  const currentSaves = toNumber(
    resolvedCategories.find((cat) => cat.key === "SV")?.value
  );
  const savesEmergency = needsSaves && currentSaves !== null && currentSaves <= 1;

  if (targetKeys.length > 0) {
    console.log(
      cYellow(
        pointGainTargets.length > 0
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
      console.log(fmtBullet(`${cat.key} ${rankLabel}, val ${cat.value}${infoText}`));
    });
  } else {
    console.log(fmtLine("Could not infer category ranks from standings."));
  }
  console.log("");

  let rosterState = [];
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
  let startLabel = null;
  let startMessage = null;
  let dropHeader = null;
  let dropMessage = null;
  let dropLines = [];
  let dropSuggestions = [];
  const actionSuggestions = {
    addBatting: [],
    addPitching: [],
    add: [],
    start: [],
    drop: [],
  };

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
      const suggestedPlayers = basePlayers.map((player) => ({
          player,
          name: extractPlayerName(player),
          positions: extractPlayerPositions(player),
          isPitcher: isPitcherPositions(extractPlayerPositions(player)),
          rank: extractPlayerRank(player),
          playerKey: extractPlayerKey(player),
        }));
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
      (config.doNotDrop || []).map((name) => name.toLowerCase())
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
          rank,
          playerKey,
          stats,
          status,
          isPitcher: isPitcherPositions(positions),
          isBench: isBenchPosition(selected),
          isIL: isILPosition(selected) || isILStatus(status),
        };
      });
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
        !doNotDrop.has(player.name.toLowerCase())
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
      }
    }

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
      startCandidates = applyStalePenalty(startCandidates, staleRecommendationNames);
      if (startCandidates.length === 0 && benchPlayers.length > 0) {
        startCandidates = applyStalePenalty(
          benchPlayers
            .filter((player) => !player.isIL)
            .filter((player) => !isUnavailableStatus(player.status)),
          staleRecommendationNames
        ).sort((a, b) => {
          if (a.rank === null && b.rank === null) return 0;
          if (a.rank === null) return 1;
          if (b.rank === null) return -1;
          return a.rank - b.rank;
        });
      }
      startSelections = startCandidates.slice(0, topLimit);
      if (startSelections.length > 0) {
        startLabel =
          battingNeeds || pitchingNeeds
            ? "START (bench fits needs):"
            : "START (bench best available):";
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
          !doNotDrop.has(player.name.toLowerCase()) &&
          canDropCatcher(player) &&
          !isProtectedBenchPlayer(player) &&
          (savesEmergency
            ? true
            : player.rank === null || player.rank >= dropRankFloorPrimary) &&
          !(player.isPitcher && player.positions.includes("SP") && player.rank === null)
      );
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
          dropLines.push(
            `- ${player.name} ${position ? `(${position})` : ""} (${statusText})`.trim()
          );
          dropSuggestions.push({
            name: player.name,
            playerKey: player.playerKey,
            isPitcher: player.isPitcher,
            rank: player.rank,
            statusDrop: true,
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
                !doNotDrop.has(player.name.toLowerCase()) &&
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
                !doNotDrop.has(player.name.toLowerCase()) &&
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
            });
          });
        }
      }

      if (dropSuggestions.length === 0 && !dropPrinted) {
        dropMessage = "DROP: recent stats unavailable.";
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
    return {
      ...candidate,
      statsScore: projected !== null && projected !== undefined ? projected : fallbackScore(candidate, isPitcher),
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

  // Rebuild queues now that drop suggestions may have history-informed statsScore.
  dropHittersQueue = dropSuggestions
    .filter((drop) => !drop.isPitcher)
    .map((d) => ({ ...d }));
  dropPitchersQueue = dropSuggestions
    .filter((drop) => drop.isPitcher)
    .map((d) => ({ ...d }));

  let addPrintedCount = 0;
  const printAddCandidates = (label, candidates, isPitcher) => {
    if (!candidates || candidates.length === 0) return;
    if (!label) return;
    const ordered = [...candidates].sort((a, b) => {
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
      console.log(
        fmtBullet(
          `${item.name} ${position ? `(${position})` : ""} -> drop ${dropName}`.trim()
        )
      );
      addPrintedCount += 1;
      if (isPitcher === null) {
        actionSuggestions.add.push(item.name);
      } else if (isPitcher) {
        actionSuggestions.addPitching.push(item.name);
      } else {
        actionSuggestions.addBatting.push(item.name);
      }
    });
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
    console.log(cYellow("ADD:") + " " + fmtLine("none (no safe drop upgrades available)."));
  }

  if (startSelections.length > 0) {
    printActionsHeader();
    console.log(cYellow(startLabel));
    startSelections.forEach((player) => {
      const position = player.positions.join(", ");
      console.log(
        fmtBullet(`${player.name} ${position ? `(${position})` : ""}`.trim())
      );
      actionSuggestions.start.push(player.name);
    });
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
    actionSuggestions,
    rosterState,
  });
  appendJsonl(SNAPSHOT_LOG, snapshot);

  const actionsLog = readJsonl(ACTION_LOG);
  const snapshotsLog = readJsonl(SNAPSHOT_LOG);
  const effectivenessLines = buildEffectivenessSummary(snapshotsLog, snapshot);
  console.log(cYellow("Effectiveness since last run:"));
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
        logActionsEntry({ adds, drops, starts, benches, notes });
      } catch (error) {
        console.log(`Log actions failed: ${error.message}`);
      }
    }
  }
}

function logActionsEntry({ adds, drops, starts, benches, notes }) {
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
  console.log("Logged actions for last recommendation.");
}

async function logActions() {
  const adds = getListArg("--add");
  const drops = getListArg("--drop");
  const starts = getListArg("--start");
  const benches = getListArg("--bench");
  const notes = getArgValue("--notes");
  logActionsEntry({ adds, drops, starts, benches, notes });
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
    } else if (command === "recommend") {
      await recommend();
    } else {
      console.log(
        "Usage: node fantasy/cli.js <auth|check|cleanup|discover|dashboard|log|recommend> [--top N] [--position C] [--verbose]"
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
