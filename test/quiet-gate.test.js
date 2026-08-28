/**
 * Unit tests for the quiet gate's two hard-won rules:
 * indicator lights never count, and a state restore is not a person.
 */
import assert from "node:assert/strict";
import { config, decideDark, inClockWindow, inLightsEnvelope, isRoomLight } from "../src/quiet-gate.js";

const env = {
  PET_QUIET_ENABLED: "1",
  PET_QUIET_TZ: "Europe/Vienna",
  PET_QUIET_START: "01:00",
  PET_QUIET_END: "09:00",
  PET_QUIET_LIGHTS_ENABLED: "1",
  PET_QUIET_LIGHTS_ENVELOPE_START: "21:00",
  PET_QUIET_LIGHTS_ENVELOPE_END: "11:00"
};
const cfg = config(env);
const lights = cfg.lights;

// A smart plug's backlight is a `light.*` entity that is on 24/7. Counting it
// makes "all lights off" permanently false, which silently disables the gate.
assert.equal(isRoomLight("light.hall_lamp", lights), true);
assert.equal(isRoomLight("light.socket_a_indicator_light", lights), false);
assert.equal(isRoomLight("switch.kettle", lights), false);

// Clock window, including the midnight wrap.
const at = (iso) => new Date(iso);
assert.equal(inClockWindow(cfg, at("2026-08-28T02:30:00+02:00")), true);
assert.equal(inClockWindow(cfg, at("2026-08-28T12:00:00+02:00")), false);
assert.equal(inLightsEnvelope(cfg, at("2026-08-28T22:30:00+02:00")), true);
assert.equal(inLightsEnvelope(cfg, at("2026-08-28T10:30:00+02:00")), true);
assert.equal(inLightsEnvelope(cfg, at("2026-08-28T15:00:00+02:00")), false);

// Darkness decisions.
assert.equal(decideDark([{ entityId: "light.a", state: "off", ageSeconds: 9e5 }], lights).dark, true);
assert.equal(decideDark([{ entityId: "light.a", state: "on", ageSeconds: 7200 }], lights).dark, false);

// An integration reconnect replays stale `on` states. Seen nightly on Xiaomi
// Home: the ceiling light "turns on" for 6 seconds at 04:30 and the strip for
// half an hour. Neither is a person, so a fresh `on` has to hold first.
const restored = decideDark([{ entityId: "light.ceiling", state: "on", ageSeconds: 6 }], lights);
assert.equal(restored.dark, true);
assert.deepEqual(restored.settling, ["light.ceiling"]);
assert.equal(decideDark([{ entityId: "light.ceiling", state: "on", ageSeconds: 91 }], lights).dark, false);

// Entities that dropped off the network are not lit rooms.
assert.equal(
  decideDark(
    [
      { entityId: "light.a", state: "unavailable", ageSeconds: 3 },
      { entityId: "light.b", state: "unknown", ageSeconds: 3 }
    ],
    lights
  ).dark,
  true
);

// Without a timestamp we cannot debounce, so trust the reported state.
assert.equal(decideDark([{ entityId: "light.a", state: "on", ageSeconds: NaN }], lights).dark, false);

console.log("quiet-gate: all assertions passed");
