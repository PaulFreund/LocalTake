// Short clock gaps can flush tiny blocks. Keep enough recyclable buffers for
// these bursts without allocating on the audio thread or growing without limit.
class LocalTakePcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.warmup = Boolean(options.processorOptions.warmup);
    this.stableFrames = 0;
    this.channels = options.processorOptions.channels;
    this.capacity = Math.round(sampleRate * 2);
    const bufferBytes = this.capacity * this.channels * 4;
    const buffers = this.warmup
      ? 0
      : Math.min(8, Math.floor((64 * 1024 * 1024) / bufferBytes));
    if (!this.warmup && buffers < 2)
      throw new Error("Audioformat überschreitet das PCM-Speicherbudget.");
    this.pool = Array.from(
      { length: buffers },
      () => new ArrayBuffer(bufferBytes),
    );
    this.buffer = null;
    this.position = 0;
    this.startFrame = 0;
    this.active = false;
    this.target = null;
    this.nextFrame = null;
    this.clockCorrections = 0;
    this.maxClockLagFrames = 0;
    this.clockLagFrames = 0;
    this.firstClockCorrectionFrame = null;
    this.lastClockCorrectionFrame = null;
    this.port.onmessage = ({ data }) => {
      if (data.type === "connect") {
        this.target = data.port;
        this.target.onmessage = ({ data: reply }) => {
          if (reply.type === "recycle") this.pool.push(reply.buffer);
        };
        this.target.start();
        this.active = true;
      }
      if (data.type === "stop") {
        this.active = false;
        this.flush();
        this.target?.postMessage({
          type: "end",
          clockCorrections: this.clockCorrections,
          maxClockLagFrames: this.maxClockLagFrames,
          clockLagFrames: this.clockLagFrames,
          firstClockCorrectionFrame: this.firstClockCorrectionFrame,
          lastClockCorrectionFrame: this.lastClockCorrectionFrame,
        });
      }
    };
  }
  flush() {
    if (this.buffer && this.position)
      this.target.postMessage(
        {
          type: "pcm",
          buffer: this.buffer.buffer,
          frames: this.position,
          firstFrame: this.startFrame,
          sampleRate,
          channels: this.channels,
        },
        [this.buffer.buffer],
      );
    this.buffer = null;
    this.position = 0;
  }
  process(inputs, outputs) {
    if (this.warmup) {
      const count = outputs[0]?.[0]?.length || 128;
      if (this.nextFrame !== null && currentFrame !== this.nextFrame)
        this.stableFrames = 0;
      this.nextFrame = currentFrame + count;
      this.stableFrames += count;
      if (this.stableFrames >= sampleRate / 10) {
        this.port.postMessage({ type: "ready" });
        return false;
      }
      return true;
    }
    if (!this.active || !this.target) return true;
    const input = inputs[0] || [];
    const count = outputs?.[0]?.[0]?.length || input[0]?.length || 128;
    // Chromium processes a node once per render quantum, but updating the
    // worklet's global currentFrame uses a try-lock and can leave a stale value.
    // A repeated timestamp therefore does not mean the delivered PCM is a duplicate.
    // Advance by the actual render size until the global clock catches up.
    // Positive jumps beyond that counter still preserve genuine discontinuities.
    const lag =
      this.nextFrame === null ? 0 : Math.max(0, this.nextFrame - currentFrame);
    if (lag > sampleRate) {
      this.active = false;
      this.flush();
      this.target.postMessage({
        type: "error",
        message:
          "Audiozeitbasis liegt mehr als eine Sekunde zurück. Gesicherte Segmente bleiben erhalten.",
      });
      return true;
    }
    this.clockLagFrames = lag;
    if (lag) {
      this.clockCorrections++;
      this.maxClockLagFrames = Math.max(this.maxClockLagFrames, lag);
      this.firstClockCorrectionFrame ??= this.nextFrame;
      this.lastClockCorrectionFrame = this.nextFrame;
    }
    if (this.nextFrame !== null && currentFrame > this.nextFrame) this.flush();
    const frame = currentFrame + lag;
    this.nextFrame = frame + count;
    for (let i = 0; i < count; i++) {
      if (!this.buffer) {
        const bytes = this.pool.pop();
        if (!bytes) {
          this.active = false;
          this.target.postMessage({
            type: "error",
            message: "Audio-Schreibpuffer erschöpft. Spur angehalten.",
          });
          return true;
        }
        this.buffer = new Float32Array(bytes);
        this.startFrame = frame + i;
      }
      for (let channel = 0; channel < this.channels; channel++)
        this.buffer[this.position * this.channels + channel] =
          input[channel]?.[i] ?? 0;
      if (++this.position === this.capacity) this.flush();
    }
    return true;
  }
}
registerProcessor("localtake-pcm", LocalTakePcm);
