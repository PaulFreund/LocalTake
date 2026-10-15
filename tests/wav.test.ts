import { expect, it } from "vitest";
import { encodeWav, wavHeader } from "../apps/client/src/recorder/wav.js";
it("stores signed Float32 samples and channels without quantization and enforces RIFF limits", () => {
  const samples = new Float32Array([0, -0.75, 0.5, 1.2]);
  const bytes = encodeWav(samples, 48_000, 2),
    view = new DataView(bytes);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
  expect(view.getUint16(20, true)).toBe(3);
  expect(view.getUint32(44, true)).toBe(2);
  expect(view.getUint32(52, true)).toBe(16);
  samples.forEach((sample, i) =>
    expect(view.getFloat32(56 + i * 4, true)).toBe(sample),
  );
  expect(() => wavHeader(48_000, 2, 600_000_000)).toThrow();
});
