import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deviceSwitchError,
  isSystemDenial,
  groupDevices,
  mediaErrorKind,
  mediaStatusText,
  overallMediaStatus,
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
  assert.match(deviceSwitchError("NotReadableError", "video"), /camera is in use by another app/);
  assert.match(deviceSwitchError("NotFoundError", "audio"), /microphone isn't connected/);
  assert.match(deviceSwitchError("NotAllowedError", "audio"), /microphone is blocked\. Allow it in the address bar/);
  assert.match(
    deviceSwitchError("NotAllowedError", "video", true),
    /Allow it in System Settings › Privacy/,
  );
  assert.match(deviceSwitchError(undefined, "video"), /previous one/);
});

test("a denial by the operating system is told apart from the browser's", () => {
  assert.equal(
    isSystemDenial({ name: "NotAllowedError", message: "Permission denied by system" }),
    true,
  );
  assert.equal(isSystemDenial({ name: "NotAllowedError", message: "Permission denied" }), false);
  assert.equal(isSystemDenial({ name: "NotReadableError", message: "denied by system" }), false);
  assert.equal(isSystemDenial(null), false);
});

test("a getUserMedia failure maps to what is wrong with that device", () => {
  assert.equal(mediaErrorKind("NotAllowedError"), "denied");
  assert.equal(mediaErrorKind("SecurityError"), "denied");
  assert.equal(mediaErrorKind("NotFoundError"), "missing");
  assert.equal(mediaErrorKind("OverconstrainedError"), "missing");
  assert.equal(mediaErrorKind("NotReadableError"), "error");
  assert.equal(mediaErrorKind(undefined), "error");
});

test("the stream is ready while either device works", () => {
  assert.equal(overallMediaStatus("ready", "ready"), "ready");
  assert.equal(overallMediaStatus("error", "ready"), "ready", "busy camera, working mic");
  assert.equal(overallMediaStatus("ready", "missing"), "ready", "camera, no mic");
  assert.equal(overallMediaStatus("off", "off"), "idle");
  assert.equal(overallMediaStatus("denied", "denied"), "denied");
  assert.equal(overallMediaStatus("denied", "missing"), "denied");
  assert.equal(overallMediaStatus("missing", "missing"), "missing");
  assert.equal(overallMediaStatus("error", "missing"), "error");
});

test("the message names the device that is not working, tersely", () => {
  assert.equal(mediaStatusText("ready", "ready"), null);
  assert.equal(mediaStatusText("off", "off"), null);
  assert.equal(
    mediaStatusText("error", "ready"),
    "Camera is in use by another app. You can still talk.",
  );
  assert.equal(
    mediaStatusText("denied", "ready"),
    "Camera blocked: allow it in the address bar. You can still talk.",
  );
  assert.equal(mediaStatusText("ready", "missing"), "No microphone found. Your camera still works.");
  assert.equal(
    mediaStatusText("denied", "denied"),
    "Camera and microphone blocked: allow them in the address bar.",
  );
  assert.equal(mediaStatusText("missing", "missing"), "No camera or microphone found.");
  assert.equal(
    mediaStatusText("error", "denied"),
    "Camera is in use by another app. Microphone blocked: allow it in the address bar.",
  );
});

test("an operating-system denial points at System Settings, not the address bar", () => {
  assert.equal(
    mediaStatusText("denied", "ready", { camera: true }),
    "Camera blocked: allow it in System Settings › Privacy. You can still talk.",
  );
  assert.equal(
    mediaStatusText("denied", "denied", { camera: true, mic: true }),
    "Camera and microphone blocked: allow them in System Settings › Privacy.",
  );
  assert.equal(
    mediaStatusText("denied", "denied", { camera: true }),
    "Camera blocked: allow it in System Settings › Privacy. Microphone blocked: allow it in the address bar.",
  );
});
