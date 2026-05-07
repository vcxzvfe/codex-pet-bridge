#!/usr/bin/env node
import http from "node:http";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = numberFromEnv("PET_BRIDGE_PORT", 17366);
const HOST = process.env.PET_BRIDGE_HOST || "127.0.0.1";
const LOG_PATH = resolve(process.env.PET_BRIDGE_LOG || "./events.jsonl");
const WEBHOOK_URL = process.env.PET_WEBHOOK_URL || "";
const WEBHOOK_TOKEN = process.env.PET_WEBHOOK_TOKEN || "";
const XIAOZHI_ASSISTANT_URL = stripTrailingSlash(process.env.XIAOZHI_ASSISTANT_URL || "");
const XIAOZHI_SOURCE_PREFIX = process.env.XIAOZHI_SOURCE_PREFIX || "";
const XIAOZHI_WEBHOOK_TOKEN = process.env.XIAOZHI_WEBHOOK_TOKEN || "";
const INBOUND_TOKEN = process.env.PET_BRIDGE_TOKEN || "";
const MAX_EVENTS = numberFromEnv("PET_BRIDGE_MAX_EVENTS", 200);
const MAX_NOTIFICATIONS = numberFromEnv("PET_BRIDGE_MAX_NOTIFICATIONS", 100);
const MAX_BODY_BYTES = numberFromEnv("PET_BRIDGE_MAX_BODY_BYTES", 65536);
const MAX_MESSAGE_CHARS = numberFromEnv("PET_BRIDGE_MAX_MESSAGE_CHARS", 500);
const STATE_PATH = resolve(process.env.PET_BRIDGE_STATE || "./bridge-state.json");
const OUTBOX_MAX = numberFromEnv("PET_BRIDGE_OUTBOX_MAX", 300);
const OUTBOX_FLUSH_MAX = numberFromEnv("PET_BRIDGE_OUTBOX_FLUSH_MAX", 25);
const OUTBOX_FLUSH_INTERVAL_MS = numberFromEnv("PET_BRIDGE_OUTBOX_FLUSH_INTERVAL_MS", 30000);
const SINK_TIMEOUT_MS = numberFromEnv("PET_BRIDGE_SINK_TIMEOUT_MS", numberFromEnv("XIAOZHI_WEBHOOK_TIMEOUT_MS", 1200));
const STORE_RAW_EVENTS = process.env.PET_BRIDGE_STORE_RAW === "1";
const NOTIFY_STATUSES = new Set(
  (process.env.PET_NOTIFY_STATUSES || "needs-attention,completed,near-complete,error")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const NOTIFY_THROTTLE_MS = numberFromEnv("PET_NOTIFY_THROTTLE_MS", 15000);
const NOTIFICATION_WEBHOOK_URL = process.env.PET_NOTIFICATION_WEBHOOK_URL || "";

const recentEvents = [];
const recentNotifications = [];
const sinkOutbox = [];
const notificationThrottle = new Map();
const sseClients = new Set();
const deliveryState = {
  lastError: "",
  lastSuccessAt: ""
};
let flushPromise = null;
let persistPromise = Promise.resolve();

if (!isLoopbackHost(HOST) && !INBOUND_TOKEN && process.env.PET_BRIDGE_ALLOW_UNAUTH_REMOTE !== "1") {
  console.error("Refusing to listen on a non-loopback host without PET_BRIDGE_TOKEN.");
  console.error("Use SSH tunneling, set PET_BRIDGE_TOKEN, or set PET_BRIDGE_ALLOW_UNAUTH_REMOTE=1 for a trusted lab network.");
  process.exit(1);
}

await loadPersistentState();

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (!isAuthorized(req, url)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "codex-pet-bridge",
        events: recentEvents.length,
        notifications: unreadNotifications().length,
        outboxDepth: sinkOutbox.length,
        lastDeliveryError: deliveryState.lastError || null,
        lastDeliverySuccessAt: deliveryState.lastSuccessAt || null
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/state") {
      sendJson(res, 200, {
        ok: true,
        current: recentEvents.at(-1) || null,
        latestNotification: unreadNotifications().at(0) || null,
        unreadCount: unreadNotifications().length
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      sendJson(res, 200, { ok: true, events: recentEvents });
      return;
    }

    if (req.method === "GET" && url.pathname === "/notifications") {
      const includeRead = url.searchParams.get("include_read") === "1";
      const limit = numberFromValue(url.searchParams.get("limit"), MAX_NOTIFICATIONS);
      const notifications = (includeRead ? recentNotifications : unreadNotifications()).slice(0, limit);
      sendJson(res, 200, { ok: true, unreadCount: unreadNotifications().length, notifications });
      return;
    }

    if (req.method === "GET" && url.pathname === "/notifications/next") {
      sendJson(res, 200, { ok: true, notification: unreadNotifications().at(0) || null });
      return;
    }

    if (req.method === "GET" && url.pathname === "/esp32/poll") {
      const ackId = url.searchParams.get("ack");
      if (ackId) await ackNotification(ackId);
      sendJson(res, 200, compactDeviceState());
      return;
    }

    if (req.method === "GET" && url.pathname === "/stream") {
      openEventStream(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/events") {
      const body = await readJson(req);
      const event = normalizeEvent(body);
      await publishEvent(event);
      sendJson(res, 202, { ok: true, event });
      return;
    }

    const ackMatch = url.pathname.match(/^\/notifications\/([^/]+)\/ack$/);
    if (req.method === "POST" && ackMatch) {
      const notification = await ackNotification(ackMatch[1]);
      sendJson(res, notification ? 200 : 404, { ok: Boolean(notification), notification });
      return;
    }

    if (req.method === "POST" && url.pathname === "/notifications/ack-all") {
      const count = await ackAllNotifications();
      sendJson(res, 200, { ok: true, count });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`codex-pet-bridge listening on http://${HOST}:${PORT}`);
  console.log(`event log: ${LOG_PATH}`);
  if (WEBHOOK_URL) {
    console.log(`webhook sink enabled: ${WEBHOOK_URL}`);
  }
  if (NOTIFICATION_WEBHOOK_URL) {
    console.log(`notification webhook enabled: ${NOTIFICATION_WEBHOOK_URL}`);
  }
  if (XIAOZHI_ASSISTANT_URL) {
    console.log(`xiaozhi assistant sink enabled: ${XIAOZHI_ASSISTANT_URL}`);
  }
  if (sinkOutbox.length) {
    console.log(`sink outbox loaded: ${sinkOutbox.length} pending delivery records`);
  }
});

setInterval(() => {
  void flushSinkOutbox();
}, OUTBOX_FLUSH_INTERVAL_MS).unref();

void flushSinkOutbox();

function normalizeEvent(input = {}) {
  const now = new Date().toISOString();
  const raw = typeof input === "object" && input !== null ? input : { value: input };
  const source = stringValue(raw.source) || inferSource(raw) || "unknown";
  const type = stringValue(raw.type) || stringValue(raw.hook_event_name) || "status";
  const status = stringValue(raw.status) || mapHookStatus(raw);
  const message = truncate(stringValue(raw.message) || summarize(raw), MAX_MESSAGE_CHARS);

  const event = {
    id: stringValue(raw.id) || randomUUID(),
    time: stringValue(raw.time) || now,
    source,
    type,
    status,
    message,
    task: stringValue(raw.task) || stringValue(raw.codexTask) || "",
    notify: typeof raw.notify === "boolean" ? raw.notify : undefined,
    progress: numberFromValue(raw.progress, null),
    workspace: stringValue(raw.workspace) || stringValue(raw.cwd) || "",
    sessionId: stringValue(raw.sessionId) || stringValue(raw.session_id) || "",
    tool: stringValue(raw.tool) || stringValue(raw.tool_name) || ""
  };
  if (STORE_RAW_EVENTS) event.raw = redactRaw(raw);
  return event;
}

function inferSource(raw) {
  if (raw.hook_event_name || raw.session_id || raw.transcript_path) {
    return "claude-code";
  }
  if (raw.codexThreadId || raw.codex_thread_id) {
    return "codex";
  }
  return "";
}

function mapHookStatus(raw) {
  const name = stringValue(raw.hook_event_name);
  if (name === "Notification") return "needs-attention";
  if (name === "PreToolUse") return "working";
  if (name === "PostToolUse") return "working";
  if (name === "Stop") return "completed";
  if (name === "SessionStart") return "started";
  if (name === "UserPromptSubmit") return "thinking";
  return "event";
}

function summarize(raw) {
  if (raw.notification?.message) return String(raw.notification.message);
  if (raw.prompt) return `Prompt submitted: ${truncate(raw.prompt, 80)}`;
  if (raw.tool_name) return `${raw.hook_event_name || "Tool"}: ${raw.tool_name}`;
  if (raw.hook_event_name) return raw.hook_event_name;
  return "Agent event received";
}

async function publishEvent(event) {
  recentEvents.push(event);
  while (recentEvents.length > MAX_EVENTS) recentEvents.shift();

  await mkdir(dirname(LOG_PATH), { recursive: true });
  await appendFile(LOG_PATH, `${JSON.stringify(event)}\n`, "utf8");

  broadcastSse(event);

  const notification = createNotification(event);
  if (notification) {
    recentNotifications.unshift(notification);
    while (recentNotifications.length > MAX_NOTIFICATIONS) recentNotifications.pop();
    broadcastSse(notification, "notification");
  }

  await persistState();
  void flushSinkOutbox();
  void postWebhook(event, "webhook:event");
  void postXiaozhiNotification(event);
  if (notification) {
    void postWebhook(notification, "webhook:notification");
  }
}

function openEventStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");

  for (const event of recentEvents.slice(-20)) {
    writeSse(res, event);
  }
  for (const notification of recentNotifications.slice(0, 5).reverse()) {
    writeSse(res, notification, "notification");
  }

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

function broadcastSse(event, eventName) {
  for (const client of sseClients) {
    writeSse(client, event, eventName);
  }
}

function writeSse(res, event, eventName = "message") {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (eventName !== "message") {
    res.write(`id: ${event.id}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function createNotification(event) {
  if (event.notify === false) return null;
  if (event.notify !== true && !NOTIFY_STATUSES.has(event.status)) return null;

  const key = notificationKey(event);
  const now = Date.now();
  const lastSent = notificationThrottle.get(key) || 0;
  if (now - lastSent < NOTIFY_THROTTLE_MS) return null;
  notificationThrottle.set(key, now);

  return {
    id: randomUUID(),
    eventId: event.id,
    time: event.time,
    kind: "notification",
    source: event.source,
    task: taskForEvent(event),
    status: event.status,
    priority: priorityForStatus(event.status),
    title: titleForStatus(event.status),
    message: event.message,
    workspace: event.workspace,
    sessionId: event.sessionId,
    progress: event.progress,
    read: false
  };
}

function notificationKey(event) {
  return [event.source, taskForEvent(event), event.sessionId, event.workspace, event.status, event.message].join("|");
}

function titleForStatus(status) {
  if (status === "needs-attention") return "Waiting for you";
  if (status === "completed") return "Task completed";
  if (status === "near-complete") return "Almost done";
  if (status === "error") return "Needs review";
  return "Agent update";
}

function priorityForStatus(status) {
  if (status === "error") return 3;
  if (status === "needs-attention") return 2;
  return 1;
}

function unreadNotifications() {
  return recentNotifications.filter((notification) => !notification.read);
}

async function ackNotification(id) {
  const notification = recentNotifications.find((item) => item.id === id);
  if (!notification) return null;
  notification.read = true;
  notification.readAt = new Date().toISOString();
  await persistState();
  await postXiaozhiClear(notification);
  return notification;
}

async function ackAllNotifications() {
  const now = new Date().toISOString();
  let count = 0;
  for (const notification of recentNotifications) {
    if (!notification.read) {
      notification.read = true;
      notification.readAt = now;
      await postXiaozhiClear(notification);
      count += 1;
    }
  }
  await persistState();
  return count;
}

function compactDeviceState() {
  const notification = unreadNotifications().at(0) || null;
  return {
    ok: true,
    unread_count: unreadNotifications().length,
    current_status: recentEvents.at(-1)?.status || "idle",
    notification: notification
      ? {
          id: notification.id,
          source: notification.source,
          task: notification.task,
          status: notification.status,
          priority: notification.priority,
          title: notification.title,
          message: notification.message,
          project: notification.workspace,
          time: notification.time
        }
      : null
  };
}

async function postWebhook(event, kind) {
  await sendOrQueueSink(kind, event);
}

async function postXiaozhiNotification(event) {
  if (!XIAOZHI_ASSISTANT_URL) return;
  const payload = xiaozhiPayloadForEvent(event);
  if (!payload) return;
  await sendOrQueueSink("xiaozhi:event", payload);
}

async function postXiaozhiClear(notification) {
  if (!XIAOZHI_ASSISTANT_URL) return;
  const payload = {
    source: xiaozhiSourceFor(notification),
    task: notification.task || taskForEvent(notification),
    status: "clear",
    message: "Notification acknowledged",
    priority: priorityName(notification.priority),
    needs_user: false
  };
  await sendOrQueueSink("xiaozhi:clear", payload);
}

function xiaozhiPayloadForEvent(event) {
  const status = xiaozhiStatusFor(event.status);
  if (!status) return null;
  if (event.notify === false && status !== "running" && status !== "clear") return null;
  const needsUser = event.notify !== false && (
    event.notify === true || ["done", "error", "waiting_user", "blocked"].includes(status)
  );
  return {
    source: xiaozhiSourceFor(event),
    task: taskForEvent(event),
    status,
    message: event.message || titleForStatus(event.status),
    priority: priorityName(priorityForStatus(event.status)),
    needs_user: needsUser
  };
}

function xiaozhiStatusFor(status) {
  if (["thinking", "working", "started", "running", "progress", "near-complete"].includes(status)) return "running";
  if (["completed", "complete", "done", "success", "succeeded", "finished"].includes(status)) return "done";
  if (["needs-attention", "waiting", "waiting-user", "waiting_user"].includes(status)) return "waiting_user";
  if (["error", "failed", "fail", "blocked"].includes(status)) return "error";
  if (["idle", "clear", "ack", "dismissed"].includes(status)) return "clear";
  return null;
}

function xiaozhiSourceFor(event) {
  const family = sourceFamily(event.source);
  const prefix = XIAOZHI_SOURCE_PREFIX.trim().toLowerCase();
  return prefix && family ? `${prefix}-${family}` : event.source || "pet-bridge";
}

function sourceFamily(source) {
  const text = String(source || "").toLowerCase();
  if (text.includes("claude")) return "claude";
  if (text.includes("codex")) return "codex";
  if (text.includes("openclaw")) return "openclaw";
  return "";
}

function taskForEvent(event) {
  return event.task || event.sessionId || slugFromPath(event.workspace) || "agent-task";
}

function slugFromPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.split(/[\\/]/).filter(Boolean).at(-1) || "";
}

function priorityName(priority) {
  if (typeof priority === "string") return priority;
  if (priority >= 3) return "urgent";
  if (priority === 2) return "high";
  return "normal";
}

function xiaozhiHeaders() {
  const headers = { "content-type": "application/json" };
  if (XIAOZHI_WEBHOOK_TOKEN) headers.authorization = `Bearer ${XIAOZHI_WEBHOOK_TOKEN}`;
  return headers;
}

async function sendOrQueueSink(kind, payload) {
  const target = sinkTarget(kind);
  if (!target) return;
  const result = await postJsonWithTimeout(target.url, payload, target.headers);
  if (result.ok) {
    deliveryState.lastSuccessAt = new Date().toISOString();
    deliveryState.lastError = "";
    await persistState();
    return;
  }
  enqueueSink(kind, payload, result.error);
  await persistState();
}

async function flushSinkOutbox() {
  if (flushPromise) return flushPromise;
  flushPromise = doFlushSinkOutbox().finally(() => {
    flushPromise = null;
  });
  return flushPromise;
}

async function doFlushSinkOutbox() {
  if (!sinkOutbox.length) return;
  const pending = sinkOutbox.splice(0, sinkOutbox.length);
  const remaining = [];
  let delivered = 0;
  for (const item of pending) {
    if (delivered >= OUTBOX_FLUSH_MAX) {
      remaining.push(item);
      continue;
    }
    const target = sinkTarget(item.kind);
    if (!target) {
      remaining.push(item);
      continue;
    }
    const result = await postJsonWithTimeout(target.url, item.payload, target.headers);
    if (result.ok) {
      delivered += 1;
      deliveryState.lastSuccessAt = new Date().toISOString();
      deliveryState.lastError = "";
      continue;
    }
    remaining.push({
      ...item,
      attempts: Number(item.attempts || 0) + 1,
      lastError: result.error,
      lastAttemptAt: new Date().toISOString()
    });
  }
  const combined = [...remaining, ...sinkOutbox].slice(-OUTBOX_MAX);
  sinkOutbox.splice(0, sinkOutbox.length, ...combined);
  await persistState();
}

function enqueueSink(kind, payload, reason) {
  sinkOutbox.push({
    id: randomUUID(),
    kind,
    payload,
    attempts: 0,
    createdAt: new Date().toISOString(),
    lastError: reason
  });
  while (sinkOutbox.length > OUTBOX_MAX) sinkOutbox.shift();
  deliveryState.lastError = `${kind}: ${reason}`;
}

function sinkTarget(kind) {
  if (kind === "webhook:event") {
    if (!WEBHOOK_URL) return null;
    return { url: WEBHOOK_URL, headers: webhookHeaders(WEBHOOK_TOKEN) };
  }
  if (kind === "webhook:notification") {
    if (!NOTIFICATION_WEBHOOK_URL) return null;
    return { url: NOTIFICATION_WEBHOOK_URL, headers: webhookHeaders(WEBHOOK_TOKEN) };
  }
  if (kind === "xiaozhi:event" || kind === "xiaozhi:clear") {
    if (!XIAOZHI_ASSISTANT_URL) return null;
    return {
      url: `${XIAOZHI_ASSISTANT_URL}/assistant/notifications`,
      headers: xiaozhiHeaders()
    };
  }
  return null;
}

function webhookHeaders(token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function postJsonWithTimeout(targetUrl, payload, headers) {
  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SINK_TIMEOUT_MS)
    });
    if (!response.ok) {
      const error = `${response.status} ${response.statusText}`;
      console.error(`sink failed: ${error}`);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (error) {
    const message = error.message || String(error);
    console.error(`sink ignored error: ${message}`);
    return { ok: false, error: message };
  }
}

async function loadPersistentState() {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (Array.isArray(state.notifications)) {
      recentNotifications.push(...state.notifications.slice(0, MAX_NOTIFICATIONS));
    }
    if (Array.isArray(state.outbox)) {
      sinkOutbox.push(...state.outbox.slice(-OUTBOX_MAX));
    }
    if (state.deliveryState && typeof state.deliveryState === "object") {
      deliveryState.lastError = stringValue(state.deliveryState.lastError);
      deliveryState.lastSuccessAt = stringValue(state.deliveryState.lastSuccessAt);
    }
  } catch {
    // Missing or unreadable state should not stop the bridge.
  }
}

function persistState() {
  persistPromise = persistPromise.catch(() => {}).then(writePersistentState);
  return persistPromise;
}

async function writePersistentState() {
  try {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    const state = {
      version: 1,
      notifications: recentNotifications.slice(0, MAX_NOTIFICATIONS),
      outbox: sinkOutbox.slice(-OUTBOX_MAX),
      deliveryState
    };
    const tmpPath = `${STATE_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmpPath, STATE_PATH);
  } catch {
    // State persistence is best-effort; event ingestion remains available.
  }
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new Error(`request body too large; max ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.PET_BRIDGE_CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization,x-pet-bridge-token");
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function truncate(value, length) {
  const text = String(value);
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function numberFromValue(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isAuthorized(req, url) {
  if (!INBOUND_TOKEN) return true;
  const headerToken = stringValue(req.headers["x-pet-bridge-token"]);
  const auth = stringValue(req.headers.authorization);
  const bearerToken = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const queryToken = url.searchParams.get("token") || "";
  return [headerToken, bearerToken, queryToken].includes(INBOUND_TOKEN);
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function redactRaw(value) {
  if (Array.isArray(value)) return value.map(redactRaw);
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = shouldRedactKey(key) ? "[redacted]" : redactRaw(nestedValue);
  }
  return output;
}

function shouldRedactKey(key) {
  return /token|secret|password|authorization|api[_-]?key|private[_-]?key/i.test(key);
}
