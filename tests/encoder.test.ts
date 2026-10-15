import { afterEach, expect, it, vi } from "vitest";
import { preparedVideoEncoder } from "../apps/client/src/recorder/encoder.js";

afterEach(() => vi.unstubAllGlobals());
it("bounds a hung encoder start and tries software preference with the same 4K quality", async () => {
  const created: FakeEncoder[] = [];
  class FakeEncoder {
    state = "unconfigured";
    configuration!: VideoEncoderConfig;
    static async isConfigSupported(config: VideoEncoderConfig) {
      return { supported: true, config };
    }
    constructor(readonly handlers: VideoEncoderInit) {
      created.push(this);
    }
    configure(config: VideoEncoderConfig) {
      this.configuration = config;
      this.state = "configured";
    }
    encode(frame: any) {
      expect(frame.timestamp).toBe(-1_000_000);
    }
    flush() {
      if (this.configuration.hardwareAcceleration === "prefer-hardware")
        return new Promise<void>(() => {});
      this.handlers.output({ timestamp: -1_000_000 } as EncodedVideoChunk, {
        decoderConfig: {
          codec: "avc1.420033",
          codedWidth: 3840,
          codedHeight: 2160,
        },
      });
      return Promise.resolve();
    }
    close() {
      this.state = "closed";
    }
  }
  vi.stubGlobal("VideoEncoder", FakeEncoder);
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return { fillStyle: "", fillRect() {} };
      }
    },
  );
  vi.stubGlobal(
    "VideoFrame",
    class {
      timestamp: number;
      constructor(_: unknown, options: any) {
        this.timestamp = options.timestamp;
      }
      close() {}
    },
  );
  const output = vi.fn(),
    error = vi.fn();
  const config = {
    codec: "avc1.420033",
    width: 3840,
    height: 2160,
    bitrate: 50_000_000,
    framerate: 30,
  };
  const prepared = await preparedVideoEncoder(config, output, error, 10);
  expect(created).toHaveLength(2);
  expect(created[0].state).toBe("closed");
  expect(created[1].configuration).toMatchObject({
    ...config,
    hardwareAcceleration: "prefer-software",
  });
  expect(prepared.decoderConfig?.codedWidth).toBe(3840);
  expect(prepared.warning).toContain("unveränderter Auflösung");
  expect(output).not.toHaveBeenCalled(); // Dummy warmup packet is never recorded.
  created[1].handlers.output({ timestamp: 0 } as EncodedVideoChunk, {});
  expect(output).toHaveBeenCalledOnce();
  prepared.encoder.close();
  created.length = 0;
  const preferred = await preparedVideoEncoder(
    config,
    output,
    error,
    10,
    "prefer-software",
  );
  expect(created).toHaveLength(1);
  expect(preferred.hardwareAcceleration).toBe("prefer-software");
  preferred.encoder.close();
});
