import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deviceSwitchError,
  groupDevices,
  selectedDevice,
} from "./media-devices.ts";

test("devices are grouped into mics, cameras and speakers in the browser's order", () => {
  const lists = groupDevices([
    { kind: "audioinput", deviceId: "default", label: "Default - MacBook Mic" },
    { kind: "videoinput", deviceId: "cam-1", label: "FaceTime HD" },
    { kind: "audioinput", deviceId: "mic-2", label: "Yeti" },
    { kind: "audiooutput", deviceId: "default", label: "Default - Speakers" },
    { kind: "videoinput", deviceId: "cam-2", label: "Logitech C920" },
  ]);
  assert.deepEqual(lists.mics.map((d) => d.deviceId), ["default", "mic-2"]);
  assert.deepEqual(lists.cameras.map((d) => d.label), ["FaceTime HD", "Logitech C920"]);
  assert.deepEqual(lists.speakers, [{ deviceId: "default", label: "Default - Speakers" }]);
});

test("entries with no deviceId (Safari/Firefox before permission) are dropped", () => {
  const lists = groupDevices([
    { kind: "audioinput", deviceId: "", label: "" },
    { kind: "videoinput", deviceId: "", label: "" },
  ]);
  assert.deepEqual(lists, { mics: [], cameras: [], speakers: [] });
});

test("an unlabelled device gets a numbered name instead of a blank option", () => {
  const lists = groupDevices([
    { kind: "videoinput", deviceId: "a", label: "" },
    { kind: "videoinput", deviceId: "b", label: "   " },
    { kind: "audioinput", deviceId: "m", label: null },
  ]);
  assert.deepEqual(lists.cameras.map((d) => d.label), ["Camera 1", "Camera 2"]);
  assert.deepEqual(lists.mics.map((d) => d.label), ["Microphone 1"]);
});

test("duplicates and unknown kinds are ignored", () => {
  const lists = groupDevices([
    { kind: "audioinput", deviceId: "x", label: "One" },
    { kind: "audioinput", deviceId: "x", label: "One again" },
    { kind: "something-new", deviceId: "y", label: "?" },
  ]);
  assert.deepEqual(lists.mics, [{ deviceId: "x", label: "One" }]);
  assert.equal(lists.cameras.length + lists.speakers.length, 0);
});

test("the picker shows the device in use, else default, else the first", () => {
  const opts = [
    { deviceId: "default", label: "Default" },
    { deviceId: "a", label: "A" },
  ];
  assert.equal(selectedDevice(opts, "a"), "a");
  assert.equal(selectedDevice(opts, "gone"), "default");
  assert.equal(selectedDevice(opts, null), "default");
  assert.equal(selectedDevice([{ deviceId: "a", label: "A" }], "gone"), "a");
  assert.equal(selectedDevice([], "a"), "");
});

test("a failed switch says what to do, by error", () => {
  assert.match(deviceSwitchError("NotReadableError", "video"), /camera is busy/);
  assert.match(deviceSwitchError("NotFoundError", "audio"), /microphone isn't connected/);
  assert.match(deviceSwitchError("NotAllowedError", "audio"), /blocked that microphone/);
  assert.match(deviceSwitchError(undefined, "video"), /previous one/);
});
