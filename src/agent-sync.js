#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTIFY_CLIENT = resolve(HERE, "notify-client.js");
const STATE_PATH = resolve(process.env.PET_AGENT_SYNC_STATE || join(homedir(), ".codex-pet-bridge", "agent-sync-state.json"));
const CODEX_SESSIONS_DIR = resolve(process.env.CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions"));
const CLAUDE_TURN_PATH = resolve(process.env.PET_CLAUDE_TURN_STATE || join(homedir(), ".codex-pet-bridge", "claude-turn.json"));
const SOURCE_PREFIX = process.env.PET_AGENT_SYNC_PREFIX || "local";
const ACTIVE_WINDOW_MS = numberFromEnv("PET_AGENT_SYNC_ACTIVE_WINDOW_MS", 45000);
const TAIL_BYTES = numberFromEnv("PET_AGENT_SYNC_TAIL_BYTES", 512 * 1024);
const CLAUDE_TURN_MAX_AGE_MS = numberFromEnv("PET_AGENT_SYNC_CLAUDE_TURN_MAX_AGE_MS", 900000);
const TURN_START_TYPES = new Set(["task_started", "user_message"]);
const TURN_END_TYPES = new Set(["task_complete", "turn_complete", "turn_aborted", "error", "shutdown_complete"]);
const REFRESH_MS = numberFromEnv("PET_AGENT_SYNC_REFRESH_MS", 90000);
const WATCH_INTERVAL_MS = numberFromEnv("PET_AGENT_SYNC_INTERVAL_MS", 15000);

const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  printHelp();
  process.exit(0);
}

if (args.has("--watch")) {
  await tick();
  setInterval(() => void tick(), WATCH_INTERVAL_MS);
} else {
  await tick();
}

async function tick() {
  const state = await loadState();
  await updateChannel(state, {
    key: "codex",
    active: await codexActive(),
    source: `${SOURCE_PREFIX}-codex`,
    task: `${SOURCE_PREFIX}-codex-runtime`,
    runningMessage: `${SOURCE_PREFIX} Codex task is running`,
    doneMessage: `${SOURCE_PREFIX} Codex task finished`
  });
  await updateChannel(state, {
    key: "claude",
    active: await claudeActive(),
    source: `${SOURCE_PREFIX}-claude`,
    task: `${SOURCE_PREFIX}-claude-session`,
    runningMessage: `${SOURCE_PREFIX} Claude Code is working`,
    doneMessage: `${SOURCE_PREFIX} Claude Code response stopped`
  });
  notify(["--flush"]);
  state.updatedAt = new Date().toISOString();
  await saveState(state);
}

async function updateChannel(state, options) {
  const now = Date.now();
  const wasActive = Boolean(state[`${options.key}Active`]);
  const lastNotify = Number(state[`${options.key}LastRunningNotify`] || 0);
  if (options.active) {
    if (!wasActive || now - lastNotify >= REFRESH_MS) {
      notify([
        "--source", options.source,
        "--task", options.task,
        "--status", "running",
        "--message", options.runningMessage,
        "--no-notify"
      ]);
      state[`${options.key}LastRunningNotify`] = now;
    }
    state[`${options.key}Active`] = true;
    state[`${options.key}LastSeen`] = now;
  } else if (wasActive) {
    notify([
      "--source", options.source,
      "--task", options.task,
      "--status", "completed",
      "--message", options.doneMessage,
      "--notify"
    ]);
    state[`${options.key}Active`] = false;
    state[`${options.key}LastRunningNotify`] = 0;
  }
}

function notify(extraArgs) {
  const result = spawnSync(process.execPath, [NOTIFY_CLIENT, ...extraArgs], {
    stdio: "ignore",
    timeout: numberFromEnv("PET_AGENT_SYNC_NOTIFY_TIMEOUT_MS", 3000)
  });
  return result.status === 0;
}

async function codexActive() {
  return (await codexSessionActive()) || codexCliActive();
}

/**
 * A rollout counts as active only when its newest turn boundary is a start.
 *
 * Reading just the last line does not work: Codex writes token_count,
 * sub-agent activity, and inter-agent metadata *after* task_complete, and the
 * desktop app keeps one rollout open for hours, so the last line is almost
 * never the completion record and every session read as permanently running.
 * A turn whose start has scrolled out of the tail window reads as closed,
 * which is the safe direction: a missed indicator beats one that never stops.
 */
async function codexSessionActive() {
  const now = Date.now();
  const files = listRecentJsonl(CODEX_SESSIONS_DIR, 12);
  for (const path of files) {
    if (now - path.mtimeMs > ACTIVE_WINDOW_MS) continue;
    if (await sessionTurnOpen(path.path)) return true;
  }
  return false;
}

async function sessionTurnOpen(path) {
  let lastStart = -1;
  let lastEnd = -1;
  const lines = await tailLines(path, TAIL_BYTES);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("task_") && !line.includes("turn_") && !line.includes("user_message")) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = record.payload?.type || record.type;
    if (TURN_START_TYPES.has(kind)) lastStart = index;
    else if (TURN_END_TYPES.has(kind)) lastEnd = index;
  }
  return lastStart > lastEnd;
}

function codexCliActive() {
  for (const proc of listProcesses()) {
    if (proc.pid === process.pid) continue;
    const command = proc.command.toLowerCase();
    if (!/\bcodex\b/.test(command)) continue;
    if (!command.includes(" exec ")) continue;
    if (proc.cpu >= 1 || proc.stat.includes("R")) return true;
  }
  return false;
}

/**
 * Claude Code activity comes from the hooks, not from process CPU.
 *
 * `ps` %cpu is a decaying average, so an app that was busy a minute ago still
 * reports over 1%, and a Claude turn is mostly network wait anyway. The
 * UserPromptSubmit/Stop hooks bracket a turn exactly; claude-hook.js writes
 * that boundary to a small state file and this reads it. Stale open turns
 * (crash, Ctrl+C) expire so nothing gets stuck "running".
 */
async function claudeActive() {
  if (process.env.PET_AGENT_SYNC_CLAUDE_PROCESS_SCAN === "1") return claudeProcessBusy();
  try {
    const turn = JSON.parse(await readFile(CLAUDE_TURN_PATH, "utf8"));
    if (turn.state !== "running") return false;
    return Date.now() - Number(turn.ts || 0) <= CLAUDE_TURN_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** Opt-in legacy heuristic, for setups without Claude Code hooks. */
function claudeProcessBusy() {
  for (const proc of listProcesses()) {
    if (proc.pid === process.pid) continue;
    const command = proc.command.toLowerCase();
    if (!/\bclaude\b/.test(command)) continue;
    if (command.includes("claude-hook") || command.includes("agent-sync")) continue;
    if (proc.cpu >= 1 || proc.stat.includes("R")) return true;
  }
  return false;
}

function listProcesses() {
  try {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,stat=,pcpu=,command="], {
      encoding: "utf8",
      timeout: 1000
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        return {
          pid: Number(parts[0]),
          stat: parts[1] || "",
          cpu: Number(parts[2] || 0),
          command: parts.slice(3).join(" ")
        };
      })
      .filter((proc) => Number.isFinite(proc.pid));
  } catch {
    return [];
  }
}

function listRecentJsonl(root, limit) {
  try {
    const output = execFileSync("/usr/bin/find", [root, "-type", "f", "-name", "*.jsonl", "-print"], {
      encoding: "utf8",
      timeout: 1000
    });
    return output
      .split("\n")
      .filter(Boolean)
      .map((path) => {
        try {
          const statOutput = execFileSync("/usr/bin/stat", ["-f", "%m", path], { encoding: "utf8", timeout: 500 });
          return { path, mtimeMs: Number(statOutput.trim()) * 1000 };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** Read the tail of a rollout without loading a multi-hundred-MB file. */
async function tailLines(path, limitBytes) {
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - limitBytes);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8").split("\n").filter(Boolean);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function printHelp() {
  console.log(`Usage:
  pet-agent-sync [--tick] [--watch]

Environment:
  PET_AGENT_SYNC_PREFIX=laptop
  PET_BRIDGE_URL=http://127.0.0.1:17366/events
  CODEX_SESSIONS_DIR=~/.codex/sessions
  PET_AGENT_SYNC_INTERVAL_MS=15000
`);
}
