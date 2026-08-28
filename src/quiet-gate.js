#!/usr/bin/env node
/**
 * Quiet gate: decide when agent status must not light anything up.
 *
 * Two independent reasons to stay dark:
 *
 *   1. A clock window (default 01:00-09:00).
 *   2. The home has gone dark: every room light is off, inside a night
 *      envelope (default 21:00-11:00). Read live from Home Assistant.
 *
 * The lights check has to survive two things that any real smart home does:
 *
 *   - Plug and sensor backlights are `light.*` entities that are on around the
 *     clock. Left in, "all lights off" is never true. Excluded by suffix.
 *   - Integrations replay stale `on` states when they reconnect. Device state
 *     restore is not a person flipping a switch, so a freshly changed `on` is
 *     ignored until it has held for `minOnSeconds`, and known reconnect times
 *     can be listed as hold windows where the previous verdict is kept.
 *
 * Used as a library (`quietNow()`) and as a CLI (`pet-quiet-gate --explain`).
 */
import { readFile } from "node:fs/promises";

const CACHE = { value: null, at: 0 };

export function config(env = process.env) {
  return {
    enabled: env.PET_QUIET_ENABLED === "1",
    start: env.PET_QUIET_START || "01:00",
    end: env.PET_QUIET_END || "09:00",
    timeZone: env.PET_QUIET_TZ || "UTC",
    lights: {
      enabled: env.PET_QUIET_LIGHTS_ENABLED === "1",
      envelopeStart: env.PET_QUIET_LIGHTS_ENVELOPE_START || "21:00",
      envelopeEnd: env.PET_QUIET_LIGHTS_ENVELOPE_END || "11:00",
      haUrl: stripSlash(env.HA_URL || env.HOME_ASSISTANT_URL || ""),
      haToken: env.HA_TOKEN || env.HOME_ASSISTANT_TOKEN || "",
      haTokenFile: env.HA_TOKEN_FILE || "",
      excludeSuffixes: list(env.PET_QUIET_LIGHTS_EXCLUDE_SUFFIXES || "_indicator_light"),
      excludeEntities: list(env.PET_QUIET_LIGHTS_EXCLUDE || ""),
      minOnSeconds: number(env.PET_QUIET_LIGHTS_MIN_ON_SECONDS, 90),
      holdWindows: list(env.PET_QUIET_LIGHTS_HOLD_WINDOWS || ""),
      failClosed: env.PET_QUIET_LIGHTS_FAIL_CLOSED !== "0",
      timeoutMs: number(env.PET_QUIET_LIGHTS_TIMEOUT_MS, 2000)
    },
    cacheTtlMs: number(env.PET_QUIET_CACHE_TTL_MS, 30000)
  };
}

/** Minutes since midnight in the configured zone. */
function nowMinutes(timeZone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

function toMinutes(text, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
  if (!match) return toMinutes(fallback, "00:00");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return toMinutes(fallback, "00:00");
  return hour * 60 + minute;
}

function inWindow(current, start, end) {
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function inClockWindow(cfg, date = new Date()) {
  const current = nowMinutes(cfg.timeZone, date);
  return inWindow(current, toMinutes(cfg.start, "01:00"), toMinutes(cfg.end, "09:00"));
}

export function inLightsEnvelope(cfg, date = new Date()) {
  const current = nowMinutes(cfg.timeZone, date);
  return inWindow(
    current,
    toMinutes(cfg.lights.envelopeStart, "21:00"),
    toMinutes(cfg.lights.envelopeEnd, "11:00")
  );
}

function inHoldWindow(cfg, date = new Date()) {
  const current = nowMinutes(cfg.timeZone, date);
  return cfg.lights.holdWindows.some((raw) => {
    const [from, to] = String(raw).split("-");
    if (!from || !to) return false;
    return inWindow(current, toMinutes(from, "00:00"), toMinutes(to, "00:00"));
  });
}

export function isRoomLight(entityId, lights) {
  if (!entityId.startsWith("light.")) return false;
  if (lights.excludeEntities.includes(entityId)) return false;
  return !lights.excludeSuffixes.some((suffix) => suffix && entityId.endsWith(suffix));
}

/** Decide darkness from raw entity rows. Exported so it can be unit tested. */
export function decideDark(rows, lights) {
  const on = [];
  const settling = [];
  for (const row of rows) {
    const state = String(row.state || "").toLowerCase();
    if (["off", "unavailable", "unknown", "none", ""].includes(state)) continue;
    if (lights.minOnSeconds > 0 && Number.isFinite(row.ageSeconds) && row.ageSeconds < lights.minOnSeconds) {
      settling.push(row.entityId); // a state restore, not a person
      continue;
    }
    on.push(row.entityId);
  }
  return { dark: on.length === 0, lightsOn: on.sort(), settling: settling.sort() };
}

async function readToken(lights) {
  if (lights.haToken) return lights.haToken;
  if (!lights.haTokenFile) return "";
  try {
    return (await readFile(lights.haTokenFile, "utf8")).trim();
  } catch {
    return "";
  }
}

async function fetchLights(lights) {
  const token = await readToken(lights);
  if (!lights.haUrl || !token) return null;
  try {
    const response = await fetch(`${lights.haUrl}/api/states`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(lights.timeoutMs)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!Array.isArray(payload)) return null;
    const now = Date.now();
    return payload
      .filter((item) => item && isRoomLight(String(item.entity_id || ""), lights))
      .map((item) => {
        const changed = Date.parse(item.last_changed || item.last_updated || "");
        return {
          entityId: String(item.entity_id),
          state: String(item.state || ""),
          ageSeconds: Number.isFinite(changed) ? (now - changed) / 1000 : NaN
        };
      });
  } catch {
    return null;
  }
}

export async function quietNow(env = process.env, date = new Date()) {
  const cfg = config(env);
  if (!cfg.enabled) return { quiet: false, reason: "disabled" };
  if (inClockWindow(cfg, date)) return { quiet: true, reason: "clock_window" };
  if (!cfg.lights.enabled) return { quiet: false, reason: "outside_clock_window" };
  if (!inLightsEnvelope(cfg, date)) return { quiet: false, reason: "outside_lights_envelope" };

  if (Date.now() - CACHE.at < cfg.cacheTtlMs && CACHE.value) return CACHE.value;
  if (inHoldWindow(cfg, date) && CACHE.value) {
    return { ...CACHE.value, reason: "reload_window_hold" };
  }

  const rows = await fetchLights(cfg.lights);
  let result;
  if (rows === null) {
    // Unknown state at night means stay dark, not wake the sleeper.
    result = cfg.lights.failClosed
      ? { quiet: true, reason: "home_assistant_unreachable_fail_closed" }
      : { quiet: false, reason: "home_assistant_unreachable" };
  } else {
    const { dark, lightsOn, settling } = decideDark(rows, cfg.lights);
    result = {
      quiet: dark,
      reason: dark ? "all_room_lights_off" : "lights_on",
      lightsOn,
      settling,
      roomLightsTotal: rows.length
    };
  }
  CACHE.value = result;
  CACHE.at = Date.now();
  return result;
}

function stripSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function list(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await quietNow();
  console.log(JSON.stringify({ config: config(), result }, null, 2));
}
