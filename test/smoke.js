import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 17367;
const server = spawn(process.execPath, ["./src/bridge-server.js"], {
  env: { ...process.env, PET_BRIDGE_PORT: String(port), PET_BRIDGE_LOG: "./test/events.jsonl" },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForServer(port);

  const hook = spawn(process.execPath, ["./src/claude-hook.js"], {
    env: { ...process.env, PET_BRIDGE_URL: `http://127.0.0.1:${port}/events` },
    stdio: ["pipe", "pipe", "pipe"]
  });
  hook.stdin.end(JSON.stringify({ hook_event_name: "Notification", session_id: "abc", cwd: process.cwd(), notification: { message: "Approve edit?" } }));
  const [code] = await once(hook, "exit");
  if (code !== 0) throw new Error(`hook exited ${code}`);

  const response = await fetch(`http://127.0.0.1:${port}/events`);
  const body = await response.json();
  if (!body.ok || body.events.length !== 1) throw new Error("event was not recorded");
  if (body.events[0].status !== "needs-attention") throw new Error("hook status was not mapped");

  const notificationsResponse = await fetch(`http://127.0.0.1:${port}/notifications`);
  const notificationsBody = await notificationsResponse.json();
  if (!notificationsBody.ok || notificationsBody.unreadCount !== 1) throw new Error("notification was not queued");
  if (notificationsBody.notifications[0].title !== "Waiting for you") throw new Error("notification title was not mapped");

  const deviceResponse = await fetch(`http://127.0.0.1:${port}/esp32/poll`);
  const deviceBody = await deviceResponse.json();
  if (!deviceBody.ok || deviceBody.unread_count !== 1) throw new Error("device poll did not expose unread count");
  if (!deviceBody.notification?.id) throw new Error("device poll did not expose latest notification");

  const ackResponse = await fetch(`http://127.0.0.1:${port}/notifications/${deviceBody.notification.id}/ack`, { method: "POST" });
  const ackBody = await ackResponse.json();
  if (!ackBody.ok || !ackBody.notification.read) throw new Error("notification was not acknowledged");

  console.log("smoke ok");
} finally {
  server.kill();
}

async function waitForServer(port) {
  for (let index = 0; index < 30; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not start");
}
