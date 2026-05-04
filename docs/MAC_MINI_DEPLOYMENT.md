# Mac Mini Deployment

The preferred deployment is to make the Mac mini the always-on notification hub while keeping the MacBook Pro free of background daemons.

## Target Layout

- Mac mini runs `bridge-server.js`.
- Mac mini runs optional adapters such as Polymarket polling.
- MacBook Pro runs Claude Code, Codex, and other tools normally.
- MacBook Pro hooks send events through an SSH tunnel.
- ESP S3 / XiaoZhi reads notifications from the Mac mini.

## Manual Start

On the Mac mini:

```bash
cd /path/to/codex-pet-bridge
node ./src/bridge-server.js
```

On the MacBook Pro:

```bash
ssh -N -L 17366:127.0.0.1:17366 mac-mini
```

## LaunchAgent

For a lightweight always-on setup on the Mac mini, create:

```text
~/Library/LaunchAgents/com.zifan.codex-pet-bridge.plist
```

Example:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.zifan.codex-pet-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>/path/to/codex-pet-bridge/src/bridge-server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/codex-pet-bridge</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PET_BRIDGE_HOST</key>
    <string>127.0.0.1</string>
    <key>PET_BRIDGE_PORT</key>
    <string>17366</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.zifan.codex-pet-bridge.plist
```

Check it:

```bash
curl http://127.0.0.1:17366/health
```

## ESP S3

If the ESP S3 runs on the same LAN and cannot use SSH tunneling, expose the bridge on the Mac mini LAN address with a token:

```bash
PET_BRIDGE_HOST=0.0.0.0 PET_BRIDGE_TOKEN="<random-token>" node ./src/bridge-server.js
```

Then poll:

```http
GET http://<mac-mini-lan-ip>:17366/esp32/poll?token=<random-token>
```

Use this only on a trusted LAN. Do not expose the bridge to the public internet.

## XiaoZhi Assistant Hub

If the Mac mini already runs the XiaoZhi assistant hub, prefer forwarding semantic events to that service instead of having the ESP S3 poll this bridge directly:

```bash
XIAOZHI_ASSISTANT_URL=http://127.0.0.1:8003 \
node ./src/bridge-server.js
```

For events coming from the MacBook Pro through an SSH tunnel, add a stable device prefix:

```bash
XIAOZHI_ASSISTANT_URL=http://127.0.0.1:8003 \
XIAOZHI_SOURCE_PREFIX=mbp \
node ./src/bridge-server.js
```

The assistant hub receives `/assistant/notifications` payloads and drives the screen visual state. This avoids duplicating XiaoZhi screen policy in this bridge.

Recommended source labels:

- `mbp-codex`
- `mini-codex`
- `win-codex`
- `mbp-claude`
- `mini-claude`
- `openclaw`
