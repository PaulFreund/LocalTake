/** IEEE float WAV; small segments avoid RIFF's 4 GiB limit. */
export function wavHeader(
  sampleRate: number,
  channels: number,
  samples: number,
): ArrayBuffer {
  const bytes = samples * channels * 4;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 0xffffffff - 48)
    throw new Error("WAV-Größengrenze überschritten.");
  const buffer = new ArrayBuffer(56),
    view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, bytes + 48, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 4, true);
  view.setUint16(32, channels * 4, true);
  view.setUint16(34, 32, true);
  text(36, "fact");
  view.setUint32(40, 4, true);
  view.setUint32(44, samples, true);
  text(48, "data");
  view.setUint32(52, bytes, true);
  return buffer;
}
export function encodeWav(
  interleaved: Float32Array,
  sampleRate: number,
  channels: number,
): ArrayBuffer {
  if (interleaved.length % channels)
    throw new Error("Unvollständiges Audioframe.");
  const result = new Uint8Array(56 + interleaved.byteLength);
  result.set(
    new Uint8Array(
      wavHeader(sampleRate, channels, interleaved.length / channels),
    ),
  );
  const data = new DataView(result.buffer);
  for (let i = 0; i < interleaved.length; i++)
    data.setFloat32(56 + i * 4, interleaved[i], true);
  return result.buffer;
}
