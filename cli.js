import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
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

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendJsonl(filePath, payload) {
  ensureLogDir();
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
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

function isBenchPosition(positions) {
  return positions.some((pos) => ["BN", "BE"].includes(pos));
}

function isILStatus(status) {
  if (!status) return false;
  const normalized = status.toString().trim().toUpperCase();
  return normalized.startsWith("IL") || normalized === "IR";
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

async function fetchPlayerStatsByKeys({ accessToken, playerKeys }) {
  const statTypes = ["lastmonth", "lastweek", "season"];
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
  worstCategories,
  bestValueTargets,
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
    targets: worstCategories.map((cat) => cat.key),
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
  if (!actions || actions.length === 0) return learning;
  const lastEvaluatedId = learning.lastEvaluatedActionId;
  let pending = null;
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const action = actions[i];
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
  if (!pending) return learning;

  const snapshotMap = new Map(snapshots.map((snap) => [snap.id, snap]));
  const baseSnapshot = snapshotMap.get(pending.snapshotId);
  if (!baseSnapshot) return learning;

  const currentMap = new Map(
    currentSnapshot.categories.map((cat) => [cat.key, cat])
  );
  const baseMap = new Map(baseSnapshot.categories.map((cat) => [cat.key, cat]));
  const boosts = { ...(learning.categoryBoost || {}) };
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
  lines.push("Effectiveness:");

  const targetKeys = baseSnapshot.targets || [];
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
    boosts[key] += improved ? 0.5 : -0.2;
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
    lastEvaluatedSnapshotId: source === "inferred" ? pending.snapshotId : learning.lastEvaluatedSnapshotId,
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

function efficiencyValue(statKey, delta, pointsGain) {
  if (delta === null || delta === undefined) return null;
  if (pointsGain === null || pointsGain === undefined) return null;
  const absDelta = Math.abs(delta);
  if (absDelta === 0) return null;
  const key = (statKey || "").toString().toUpperCase();
  let scale = 1;
  if (key === "AVG") scale = 0.001;
  if (key === "ERA" || key === "WHIP") scale = 0.01;
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

function applyLearningBoosts(rankedCategories, learning) {
  const boosts = learning?.categoryBoost || {};
  return rankedCategories
    .map((cat) => ({
      ...cat,
      priorityScore: (cat.rank ?? 0) + (boosts[cat.key] || 0),
      boost: boosts[cat.key] || 0,
    }))
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

  const rankedCategories = resolvedCategories
    .filter((stat) => stat.rank !== null && !Number.isNaN(stat.rank))
    .sort((a, b) => b.rank - a.rank);

  const learning = loadLearning();
  const prioritizedCategories = applyLearningBoosts(rankedCategories, learning);
  const worstCategories = prioritizedCategories.slice(0, 3);

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

  console.log("Daily Recommendation Summary");
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
  console.log(`League ${leagueDisplay} | Team ${teamDisplay}`);
  if (summaryParts.length > 0) {
    console.log(summaryParts.join(" | "));
  }

  if (worstCategories.length > 0) {
    console.log("Targets (lowest ranks):");
    worstCategories.forEach((cat) => {
      let targetText = "";
      const rankLabel =
        cat.rankSource === "points" && cat.points !== null
          ? `~rank ${formatRank(cat.rank)} (points ${cat.points})`
          : `rank ${formatRank(cat.rank)}`;
      if (teamCount > 0 && cat.rank !== null) {
        const midRank = Math.ceil(teamCount / 2);
        const baseRank = roundRank(cat.rank);
        const targetRank = Math.max(1, Math.min(midRank, baseRank - 2));
        const delta = baseRank - targetRank;
        if (delta > 0) {
          targetText = `, target +${delta} ranks (to #${targetRank})`;
        } else {
          targetText = ", maintain (already top half)";
        }
      }
      console.log(
        `- ${cat.key} ${rankLabel}, val ${cat.value}${targetText}`
      );
    });
  } else {
    console.log("Could not infer category ranks from standings.");
  }

  let bestValueTargets = [];
  if (teamMetrics.length > 0 && myTeamMetrics) {
    console.log("Point gains (next team):");
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
        console.log(`- ${cat.key} (${cat.name}): N/A`);
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
        console.log(`- ${cat.key} (${cat.name}): N/A`);
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
        console.log(
          `- ${cat.key} (${cat.name}): leading (no immediate point gain)`
        );
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
      console.log(
        `- ${cat.key}: ${directionText} vs ${teamName} (${targetText})${pointsText}${efficiencyText}`
      );

      if (efficiency !== null && pointsGain !== null) {
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
      console.log("Best value (points per unit):");
      sorted.slice(0, topLimit).forEach((row) => {
        console.log(
          `- ${row.key} (${row.name}): ${formatEfficiency(row.efficiency)} ${row.label}`
        );
      });
      bestValueTargets = sorted.slice(0, topLimit).map((row) => row.key);
    }
  }

  let rosterState = [];
  const actionSuggestions = {
    addBatting: [],
    addPitching: [],
    add: [],
    start: [],
    drop: [],
  };

  try {
    const topLimit = getTopLimit(3);
    const freeAgents = await yahooRequest({
      url: `${FANTASY_API_BASE}/league/${config.leagueKey}/players;status=A;sort=AR;count=15?format=json`,
      accessToken,
    });
    writeDebugJson("free-agents", freeAgents);

    const players = findAllValuesByKey(freeAgents, "player");
    if (players.length > 0) {
      const worstCategoryKeys = worstCategories.map((cat) => cat.key);
      const battingNeeds = worstCategoryKeys.some((cat) =>
        battingCategories.includes(cat)
      );
      const pitchingNeeds = worstCategoryKeys.some((cat) =>
        pitchingCategories.includes(cat)
      );
      const battingFocus = worstCategoryKeys.filter((cat) =>
        battingCategories.includes(cat)
      );
      const pitchingFocus = worstCategoryKeys.filter((cat) =>
        pitchingCategories.includes(cat)
      );

      const filterByNeed = (player) => {
        const positions = extractPlayerPositions(player);
        const isPitcher = isPitcherPositions(positions);
        if (battingNeeds && !pitchingNeeds) return !isPitcher;
        if (pitchingNeeds && !battingNeeds) return isPitcher;
        return true;
      };

      const suggestedPlayers = players.filter(filterByNeed);
      if (suggestedPlayers.length > 0) {
        console.log("Actions:");
        if (battingNeeds) {
          console.log(`ADD (batting: ${battingFocus.join(", ")}):`);
          suggestedPlayers
            .filter((player) => !isPitcherPositions(extractPlayerPositions(player)))
            .slice(0, topLimit)
            .forEach((player) => {
              const name = extractPlayerName(player);
              const position = extractPlayerPositions(player).join(", ");
              console.log(`- ${name} ${position ? `(${position})` : ""}`.trim());
              actionSuggestions.addBatting.push(name);
            });
        }

        if (pitchingNeeds) {
          console.log(`ADD (pitching: ${pitchingFocus.join(", ")}):`);
          suggestedPlayers
            .filter((player) => isPitcherPositions(extractPlayerPositions(player)))
            .slice(0, topLimit)
            .forEach((player) => {
              const name = extractPlayerName(player);
              const position = extractPlayerPositions(player).join(", ");
              console.log(`- ${name} ${position ? `(${position})` : ""}`.trim());
              actionSuggestions.addPitching.push(name);
            });
        }

        if (!battingNeeds && !pitchingNeeds) {
          console.log("ADD:");
          suggestedPlayers.slice(0, topLimit).forEach((player) => {
            const name = extractPlayerName(player);
            const position = extractPlayerPositions(player).join(", ");
            console.log(`- ${name} ${position ? `(${position})` : ""}`.trim());
            actionSuggestions.add.push(name);
          });
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

    const rosterPlayers = findAllValuesByKey(roster, "player");
    rosterState = buildRosterState(rosterPlayers);
    let benchPlayers = rosterPlayers
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
      })
      .filter((player) => player.isBench && !player.isIL);

    if (!hasStats) {
      const benchKeys = benchPlayers
        .map((player) => player.playerKey)
        .filter(Boolean);
      const statsResult = await fetchPlayerStatsByKeys({
        accessToken,
        playerKeys: benchKeys,
      });
      if (statsResult.hasStats) {
        hasStats = true;
        statType = statsResult.statType;
        benchPlayers = benchPlayers.map((player) => ({
          ...player,
          stats: statsResult.statsByKey.get(player.playerKey) || new Map(),
        }));
      }
    }

    if (benchPlayers.length > 0) {
      const battingNeeds = worstCategories.some((cat) =>
        battingCategories.includes(cat.key)
      );
      const pitchingNeeds = worstCategories.some((cat) =>
        pitchingCategories.includes(cat.key)
      );

      let startCandidates = benchPlayers
        .filter((player) => !player.isIL)
        .filter((player) =>
        battingNeeds && pitchingNeeds
          ? true
          : battingNeeds
            ? !player.isPitcher
            : pitchingNeeds
              ? player.isPitcher
              : false
      );
      if (startCandidates.length === 0 && benchPlayers.length > 0) {
        startCandidates = benchPlayers
          .filter((player) => !player.isIL)
          .sort((a, b) => {
          if (a.rank === null && b.rank === null) return 0;
          if (a.rank === null) return 1;
          if (b.rank === null) return -1;
          return a.rank - b.rank;
        });
      }
      const startSelections = startCandidates.slice(0, topLimit);
      if (startSelections.length > 0) {
        const label =
          battingNeeds || pitchingNeeds
            ? "START (bench fits needs):"
            : "START (bench best available):";
        console.log(label);
        startSelections.forEach((player) => {
          const position = player.positions.join(", ");
          console.log(
            `- ${player.name} ${position ? `(${position})` : ""}`.trim()
          );
          actionSuggestions.start.push(player.name);
        });
      } else {
        console.log("START: none (bench does not fit needs).");
      }

      const startKeys = new Set(startSelections.map((player) => playerKey(player)));
      const benchWithRank = benchPlayers.filter((player) => player.rank !== null);
      const doNotDrop = new Set(
        (config.doNotDrop || []).map((name) => name.toLowerCase())
      );
      const dropPool = benchPlayers.filter(
        (player) =>
          !startKeys.has(playerKey(player)) &&
          !doNotDrop.has(player.name.toLowerCase())
      );
      const statKeysForType = (isPitcher) =>
        isPitcher ? pitchingCategories : battingCategories;
      const weakKeysForType = (isPitcher) => {
        const weak = worstCategories
          .map((cat) => cat.key)
          .filter((key) =>
            isPitcher
              ? pitchingCategories.includes(key)
              : battingCategories.includes(key)
          );
        return weak.length > 0 ? weak : statKeysForType(isPitcher);
      };

      let dropPrinted = false;
      if (hasStats) {
        const dropCandidates = dropPool
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
          .sort((a, b) => a.score - b.score);

        if (dropCandidates.length > 0) {
          console.log(`DROP (bench, recent ${statType}):`);
          dropCandidates.slice(0, topLimit).forEach((player, idx) => {
            const position = player.positions.join(", ");
            const confidence = dropConfidenceTag(
              statType,
              idx,
              dropCandidates.length,
              true
            );
            console.log(
              `- ${player.name} ${position ? `(${position})` : ""} (${confidence})`.trim()
            );
            actionSuggestions.drop.push(player.name);
          });
          dropPrinted = true;
        }
      }

      if (!dropPrinted && benchWithRank.length > 0) {
        console.log("DROP (bench, lowest Yahoo rank):");
        const fallback = benchWithRank
          .filter(
            (player) =>
              !startKeys.has(playerKey(player)) &&
              !doNotDrop.has(player.name.toLowerCase())
          )
          .sort((a, b) => b.rank - a.rank);
        fallback.slice(0, topLimit).forEach((player) => {
          const position = player.positions.join(", ");
          const rankText = player.rank ? `rank ${player.rank}` : "rank N/A";
          console.log(
            `- ${player.name} ${position ? `(${position})` : ""} ${rankText} (LOW)`.trim()
          );
          actionSuggestions.drop.push(player.name);
        });
      } else if (!dropPrinted) {
        console.log("DROP: recent stats unavailable.");
      }
    }
  } catch (error) {
    console.log("Roster actions unavailable (endpoint may be restricted).");
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
    worstCategories,
    bestValueTargets,
    actionSuggestions,
    rosterState,
  });
  appendJsonl(SNAPSHOT_LOG, snapshot);

  const actionsLog = readJsonl(ACTION_LOG);
  const snapshotsLog = readJsonl(SNAPSHOT_LOG);
  const updatedLearning = evaluateActions({
    learning,
    actions: actionsLog,
    snapshots: snapshotsLog,
    currentSnapshot: snapshot,
  });
  saveLearning(updatedLearning);

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
    } else if (command === "recommend") {
      await recommend();
    } else {
      console.log(
        "Usage: node fantasy/cli.js <auth|check|cleanup|discover|log|recommend> [--top N]"
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
