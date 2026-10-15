import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CaptureManager } from "../apps/client/src/capture/manager.js";
import {
  preferredDevice,
  rememberDevice,
} from "../apps/client/src/capture/preferences.js";

class Track extends EventTarget {
  readyState = "live";
  enabled = true;
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  constructor(
    readonly kind: "video" | "audio",
    readonly label: string,
    readonly deviceId: string,
  ) {
    super();
  }
  getSettings() {
    return this.kind === "video"
      ? { deviceId: this.deviceId, width: 3840, height: 2160, frameRate: 30 }
      : { deviceId: this.deviceId, sampleRate: 48000, channelCount: 2 };
  }
}
function stream(kind: "video" | "audio", deviceId: string) {
  const track = new Track(kind, deviceId, deviceId);
  return {
    track,
    getTracks: () => [track],
    getAudioTracks: () => (kind === "audio" ? [track] : []),
  };
}
function node() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}
class Context {
  state = "running";
  createMediaStreamDestination() {
    return { stream: stream("audio", "mix") };
  }
  createMediaStreamSource() {
    return node();
  }
  createAnalyser() {
    return { ...node(), fftSize: 256 };
  }
  createGain() {
    return { ...node(), gain: { value: 1 } };
  }
}
const device = (id: string, kind: MediaDeviceKind = "videoinput") => ({
  deviceId: id,
  kind,
  label: id,
  groupId: id,
  toJSON: () => ({}),
});
let getUserMedia: ReturnType<typeof vi.fn>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let capture: CaptureManager;
beforeEach(() => {
  enumerateDevices = vi.fn(async () => [
    device("camera-virtual"),
    device("camera-primary"),
    device("microphone-primary", "audioinput"),
  ]);
  getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    const kind = constraints.video ? "video" : "audio";
    const settings = (constraints.video ||
      constraints.audio) as MediaTrackConstraints;
    const id =
      (settings.deviceId as { exact?: string } | undefined)?.exact ||
      (kind === "video" ? "camera-virtual" : "microphone-primary");
    return stream(kind, id);
  });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia, enumerateDevices },
  });
  vi.stubGlobal("AudioContext", Context);
  capture = new CaptureManager();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("opens the working camera after an unavailable virtual default without changing the microphone", async () => {
  const mic = await capture.add("audio", "microphone-primary", "2160");
  getUserMedia.mockRejectedValueOnce(
    new DOMException("Virtual camera has no producer", "NotReadableError"),
  );
  const camera = await capture.addDefault("video", "2160");
  expect(camera.settings.deviceId).toBe("camera-primary");
  expect(getUserMedia).toHaveBeenCalledTimes(3);
  expect(getUserMedia.mock.calls[1][0].video.deviceId).toEqual({
    exact: "camera-virtual",
  });
  expect(getUserMedia.mock.calls[2][0].video.deviceId).toEqual({
    exact: "camera-primary",
  });
  expect(capture.sources[0]).toBe(mic);
  expect((mic.track as unknown as Track).stop).not.toHaveBeenCalled();
});

it("uses the saved camera directly and never substitutes another for an explicit failed choice", async () => {
  const camera = await capture.addDefault("video", "2160", "camera-primary");
  expect(camera.settings.deviceId).toBe("camera-primary");
  expect(enumerateDevices).not.toHaveBeenCalled();
  getUserMedia.mockRejectedValueOnce(
    new DOMException("Busy", "NotReadableError"),
  );
  await expect(
    capture.addDefault("video", "2160", "camera-virtual"),
  ).rejects.toMatchObject({ name: "NotReadableError" });
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(capture.sources).toEqual([camera]);
});

it("does not retry a denied permission or unsupported profile on other cameras", async () => {
  for (const name of ["NotAllowedError", "OverconstrainedError"]) {
    getUserMedia.mockRejectedValueOnce(
      new DOMException("Denied or unsupported", name),
    );
    await expect(capture.addDefault("video", "2160")).rejects.toMatchObject({
      name,
    });
  }
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(enumerateDevices).toHaveBeenCalledTimes(2);
  expect(capture.sources).toEqual([]);
});

it("re-enumerates inputs after the initial permission reveals device IDs", async () => {
  enumerateDevices.mockResolvedValueOnce([device("")]);
  getUserMedia.mockRejectedValueOnce(
    new DOMException("Cannot start default", "NotReadableError"),
  );
  getUserMedia.mockRejectedValueOnce(
    new DOMException("OBS is not running", "NotReadableError"),
  );
  const camera = await capture.addDefault("video", "2160");
  expect(camera.settings.deviceId).toBe("camera-primary");
  expect(enumerateDevices).toHaveBeenCalledTimes(2);
  expect(getUserMedia).toHaveBeenCalledTimes(3);
});

it("retains the camera slot while opening a new device, then keeps it through subsequent switches", async () => {
  const camera = await capture.add("video", "camera-primary", "2160");
  const mic = await capture.add("audio", "microphone-primary", "2160");
  let resolve!: (value: ReturnType<typeof stream>) => void;
  getUserMedia.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const switching = capture.switch(camera.id, "second-camera", "2160");
  expect(capture.sources).toEqual([camera, mic]);
  expect(camera.changing).toBe(true);
  expect(camera.track.readyState).toBe("ended");
  expect(capture.selectedCamera).toBe(camera.id);
  expect(mic.track.readyState).toBe("live");
  await expect(
    capture.switch(camera.id, "third-camera", "2160"),
  ).rejects.toThrow("bereits gewechselt");
  resolve(stream("video", "second-camera"));
  const replacement = await switching;
  expect(replacement.id).not.toBe(camera.id);
  expect(replacement.slotId).toBe(camera.id);
  expect(replacement.changing).toBeFalsy();
  expect(capture.sources).toEqual([replacement, mic]);
  expect(capture.selectedCamera).toBe(replacement.id);
  const again = await capture.switch(replacement.id, "camera-primary", "2160");
  expect(again.slotId).toBe(camera.id);
  expect(capture.sources).toEqual([again, mic]);
});

it("restores the previous camera in the same slot after a failed selection", async () => {
  const camera = await capture.add("video", "camera-primary", "2160");
  const mic = await capture.add("audio", "microphone-primary", "2160");
  getUserMedia.mockRejectedValueOnce(
    new DOMException("OBS is not running", "NotReadableError"),
  );
  await expect(
    capture.switch(camera.id, "camera-virtual", "2160"),
  ).rejects.toMatchObject({
    name: "NotReadableError",
  });
  const restored = capture.sources[0];
  expect(restored.settings.deviceId).toBe("camera-primary");
  expect(restored.slotId).toBe(camera.id);
  expect(restored.changing).toBeFalsy();
  expect(restored.track.readyState).toBe("live");
  expect(capture.selectedCamera).toBe(restored.id);
  expect(capture.sources[1]).toBe(mic);
  expect((mic.track as unknown as Track).stop).not.toHaveBeenCalled();
});

it("switches only the microphone while retaining its row and the live camera", async () => {
  const camera = await capture.add("video", "camera-primary", "2160");
  const mic = await capture.add("audio", "microphone-primary", "2160");
  const replacement = await capture.switch(mic.id, "other-mic", "2160");
  expect(replacement.slotId).toBe(mic.id);
  expect(capture.sources).toEqual([camera, replacement]);
  expect(capture.cameraTrack).toBe(camera.track);
  expect((camera.track as unknown as Track).stop).not.toHaveBeenCalled();
});

it("releases a device that finishes opening after its source has been removed", async () => {
  const camera = await capture.add("video", "camera-primary", "2160");
  let resolve!: (value: ReturnType<typeof stream>) => void;
  getUserMedia.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const switching = capture.switch(camera.id, "second-camera", "2160");
  capture.remove(camera.id);
  const opened = stream("video", "second-camera");
  resolve(opened);
  await expect(switching).rejects.toThrow("während des Wechsels entfernt");
  expect(capture.sources).toEqual([]);
  expect(opened.track.stop).toHaveBeenCalledOnce();
});

it("remembers successful device selections independently and tolerates unavailable preference storage", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const camera = await capture.add("video", "camera-primary", "2160");
  const mic = await capture.add("audio", "microphone-primary", "2160");
  rememberDevice(camera, storage);
  rememberDevice(mic, storage);
  expect(preferredDevice("video", storage)).toBe("camera-primary");
  expect(preferredDevice("audio", storage)).toBe("microphone-primary");
  rememberDevice(
    { ...camera, synthetic: true, settings: { deviceId: "synthetic" } },
    storage,
  );
  expect(preferredDevice("video", storage)).toBe("camera-primary");
  expect(
    preferredDevice("video", {
      getItem: () => {
        throw new Error("Storage blocked");
      },
    }),
  ).toBe("");
  expect(() =>
    rememberDevice(camera, {
      setItem: () => {
        throw new Error("Storage blocked");
      },
    }),
  ).not.toThrow();
});
