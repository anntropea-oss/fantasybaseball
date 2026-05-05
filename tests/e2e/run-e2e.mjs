import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "e2e", "fixtures");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if ([".git", "node_modules", "logs", "debug", "docs"].includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await fsp.copyFile(from, to);
    }
  }
}

async function makeSandbox() {
  const sandboxRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fantasy-e2e-"));
  const appDir = path.join(sandboxRoot, "fantasy");
  await copyDir(REPO_ROOT, appDir);
  await fsp.mkdir(path.join(appDir, "logs"), { recursive: true });
  await fsp.mkdir(path.join(appDir, "docs"), { recursive: true });
  await fsp.copyFile(path.join(FIXTURE_DIR, "snapshots.jsonl"), path.join(appDir, "logs", "snapshots.jsonl"));
  await fsp.copyFile(path.join(FIXTURE_DIR, "actions.jsonl"), path.join(appDir, "logs", "actions.jsonl"));

  const config = JSON.parse(await fsp.readFile(path.join(appDir, "config.example.json"), "utf8"));
  config.consumerKey = "fixture-key";
  config.consumerSecret = "fixture-secret";
  config.leagueKey = "mlb.l.123";
  config.teamKey = "mlb.l.123.t.4";
  await fsp.writeFile(path.join(appDir, "config.json"), JSON.stringify(config, null, 2));

  return appDir;
}

function runNode({ cwd, args, timeoutMs = 20000, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out: node ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function startAppServer({ cwd, port }) {
  const child = spawn(process.execPath, ["cli.js", "app", "--port", String(port)], {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (child.exitCode !== null) {
      throw new Error(`App exited early (${child.exitCode}). stderr:\n${stderr}\nstdout:\n${stdout}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        return { child, baseUrl, getOutput: () => ({ stdout, stderr }) };
      }
    } catch {
      // retry until ready
    }
    await delay(150);
  }

  child.kill("SIGTERM");
  throw new Error(`App failed to start on ${baseUrl}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("close", resolve);
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 3000);
  });
}

test("db-backfill populates sqlite from JSONL fixtures", async () => {
  const cwd = await makeSandbox();
  const result = await runNode({ cwd, args: ["cli.js", "db-backfill"] });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Backfilled SQLite: 2 snapshots, 1 action logs/);

  const dbPath = path.join(cwd, "logs", "fantasy.db");
  assert.equal(fs.existsSync(dbPath), true, `Expected sqlite db at ${dbPath}`);
});

test("review command renders decision review HTML", async () => {
  const cwd = await makeSandbox();
  await runNode({ cwd, args: ["cli.js", "db-backfill"] });

  const result = await runNode({ cwd, args: ["cli.js", "review"] });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Decision review:/);

  const outPath = path.join(cwd, "logs", "decision-review.html");
  assert.equal(fs.existsSync(outPath), true);
  const html = await fsp.readFile(outPath, "utf8");
  assert.match(html, /Decision Review/);
  assert.match(html, /Closer Spec/);
  assert.match(html, /Apply Yahoo Start Active Players first/);
});

test("dashboard publish writes docs/index.html", async () => {
  const cwd = await makeSandbox();
  const result = await runNode({
    cwd,
    args: ["cli.js", "dashboard", "--publish"],
    env: { FANTASY_DASHBOARD: "1" },
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Dashboard:/);

  const publishPath = path.join(cwd, "docs", "index.html");
  assert.equal(fs.existsSync(publishPath), true);
  const html = await fsp.readFile(publishPath, "utf8");
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Fantasy Baseball Tracker/);
  assert.match(html, /Window: 2026-05-01 → 2026-05-02/);
});

test("local app exposes stable JSON API contracts", async () => {
  const cwd = await makeSandbox();
  await runNode({ cwd, args: ["cli.js", "db-backfill"] });

  const port = 18877 + Math.floor(Math.random() * 1000);
  const server = await startAppServer({ cwd, port });

  try {
    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);
    assert.match(String(healthJson.dbPath || ""), /fantasy\.db$/);

    const latest = await fetch(`${server.baseUrl}/api/latest`);
    assert.equal(latest.status, 200);
    const latestJson = await latest.json();
    assert.equal(latestJson.summary.date, "2026-05-02");
    assert.equal(latestJson.summary.teamName, "Test Team");
    assert.ok(Array.isArray(latestJson.recommendations));
    assert.ok(latestJson.recommendations.length >= 1);

    const snapshots = await fetch(`${server.baseUrl}/api/snapshots?limit=2&daily=1`);
    assert.equal(snapshots.status, 200);
    const snapshotsJson = await snapshots.json();
    assert.equal(snapshotsJson.count, 2);
    assert.equal(snapshotsJson.snapshots.at(-1).overallRank, 6);

    const recs = await fetch(`${server.baseUrl}/api/recommendations?limit=2`);
    assert.equal(recs.status, 200);
    const recsJson = await recs.json();
    assert.ok(recsJson.count >= 3);
    assert.ok(recsJson.recommendations.some((row) => row.playerName === "Closer Spec"));

    const lineup = await fetch(`${server.baseUrl}/api/lineup`);
    assert.equal(lineup.status, 200);
    const lineupJson = await lineup.json();
    assert.equal(lineupJson.date, "2026-05-02");
    assert.ok(Array.isArray(lineupJson.lineup.active));

    const effectiveness = await fetch(`${server.baseUrl}/api/effectiveness`);
    assert.equal(effectiveness.status, 200);
    const effectivenessJson = await effectiveness.json();
    assert.ok(Array.isArray(effectivenessJson.latestSummary));
    assert.ok(Array.isArray(effectivenessJson.rows));
  } finally {
    await stopProcess(server.child);
  }
});

test("unknown command returns usage string", async () => {
  const cwd = await makeSandbox();
  const result = await runNode({ cwd, args: ["cli.js", "does-not-exist"] });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: node fantasy\/cli\.js/);
});
