export function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
// Exercise the encoder before attaching capture. Capability queries alone do
// not prove that the GPU/driver can start an encoder under the current load.
// Software fallback changes the implementation, never dimensions or bitrate.
export async function preparedVideoEncoder(
  config: VideoEncoderConfig,
  output: VideoEncoderInit["output"],
  error: VideoEncoderInit["error"],
  timeoutMs = 10_000,
  preference: "prefer-hardware" | "prefer-software" = "prefer-hardware",
) {
  const failures: string[] = [];
  for (const hardwareAcceleration of preference === "prefer-software"
    ? (["prefer-software", "prefer-hardware"] as const)
    : (["prefer-hardware", "prefer-software"] as const)) {
    const candidate = { ...config, hardwareAcceleration };
    let warming = true;
    let warmError: DOMException | null = null;
    let decoderConfig: VideoDecoderConfig | undefined;
    let producedPacket = false;
    let encoder: VideoEncoder | undefined;
    try {
      const support = await within(
        VideoEncoder.isConfigSupported(candidate),
        Math.min(timeoutMs, 3000),
        "Prüfung der Encoderfähigkeiten antwortet nicht.",
      );
      if (!support.supported) throw new Error("H.264-Profil nicht unterstützt");
      encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          if (warming) {
            producedPacket = true;
            decoderConfig = metadata?.decoderConfig ?? decoderConfig;
          } else output(chunk, metadata);
        },
        error: (value) => {
          if (warming) warmError = value;
          else error(value);
        },
      });
      encoder.configure(support.config ?? candidate);
      const frame = new VideoFrame(
        new Uint8Array(config.width * config.height * 4),
        {
          format: "RGBX",
          codedWidth: config.width,
          codedHeight: config.height,
          timestamp: -1_000_000,
        },
      );
      try {
        encoder.encode(frame, { keyFrame: true });
      } finally {
        frame.close();
      }
      await within(
        encoder.flush(),
        timeoutMs,
        "Encoder antwortet beim Start nicht.",
      );
      if (warmError) throw warmError;
      if (!producedPacket)
        throw new Error("Encoder hat beim Start kein Videopaket geliefert.");
      // Keep the warmed encoder configured. The first actual frame is a keyframe
      // and receives the warmup's decoder config until updated metadata arrives.
      warming = false;
      return {
        encoder,
        decoderConfig,
        hardwareAcceleration,
        warning: failures.length
          ? "Erster Encoderstart fehlgeschlagen; alternativer Encoder mit unveränderter Auflösung und Bitrate verwendet."
          : undefined,
      };
    } catch (value) {
      failures.push(
        `${hardwareAcceleration}: ${value instanceof Error ? value.message : String(value)}`,
      );
      if (encoder && encoder.state !== "closed") encoder.close();
    }
  }
  throw new Error(
    `Videoencoder konnte nicht gestartet werden (${failures.join(" · ")}). Geräte oder Aufnahmeprofil prüfen.`,
  );
}
