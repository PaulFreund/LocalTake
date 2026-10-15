import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("retains every PCM sample when one stale clock tick catches up on the next callback", () => {
  let Processor: any;
  const scope = {
    sampleRate: 48_000,
    currentFrame: 0,
    AudioWorkletProcessor: class {
      port: any = {};
    },
    registerProcessor: (_: string, ctor: any) => {
      Processor = ctor;
    },
  };
  runInNewContext(
    readFileSync("apps/client/src/recorder/pcm-worklet.js", "utf8"),
    scope,
  );
  const messages: any[] = [];
  const processor = new Processor({ processorOptions: { channels: 2 } });
  processor.port.onmessage({
    data: {
      type: "connect",
      port: {
        start() {},
        postMessage(message: any) {
          messages.push(message);
        },
      },
    },
  });
  // Chromium can fail to publish a new global currentFrame even though its
  // audio graph has advanced and delivers a fresh render quantum.
  const clocks = [0, 128, 128, 384];
  const expected: number[] = [];
  for (const [index, frame] of clocks.entries()) {
    scope.currentFrame = frame;
    const left = Float32Array.from({ length: 128 }, (_, i) => index * 128 + i);
    const right = Float32Array.from(left, (value) => -value);
    processor.process([[left, right]], [[new Float32Array(128)]]);
    for (let i = 0; i < 128; i++) expected.push(left[i], right[i]);
  }
  processor.port.onmessage({ data: { type: "stop" } });
  const pcm = messages.filter((message) => message.type === "pcm");
  expect(pcm.map((message) => [message.firstFrame, message.frames])).toEqual([
    [0, 512],
  ]);
  expect(
    pcm.flatMap((message) =>
      Array.from(new Float32Array(message.buffer, 0, message.frames * 2)),
    ),
  ).toEqual(expected);
  expect(messages.at(-1)).toMatchObject({
    type: "end",
    clockCorrections: 1,
    maxClockLagFrames: 128,
  });
});

it("signals readiness only after a continuous 100ms audio clock interval", () => {
  let Processor: any;
  const messages: any[] = [];
  const scope = {
    sampleRate: 48_000,
    currentFrame: 0,
    AudioWorkletProcessor: class {
      port = {
        postMessage(message: any) {
          messages.push(message);
        },
      };
    },
    registerProcessor: (_: string, ctor: any) => {
      Processor = ctor;
    },
  };
  runInNewContext(
    readFileSync("apps/client/src/recorder/pcm-worklet.js", "utf8"),
    scope,
  );
  const processor = new Processor({
    processorOptions: { channels: 1, warmup: true },
  });
  const outputs = [[new Float32Array(128)]];
  for (let index = 0; index < 20; index++) {
    scope.currentFrame = index * 128;
    expect(processor.process([], outputs)).toBe(true);
  }
  // The first callback after this device-clock jump restarts the readiness interval.
  for (let index = 0; index < 37; index++) {
    scope.currentFrame = 3000 + index * 128;
    expect(processor.process([], outputs)).toBe(true);
  }
  expect(messages).toEqual([]);
  scope.currentFrame = 3000 + 37 * 128;
  expect(processor.process([], outputs)).toBe(false);
  expect(messages).toEqual([{ type: "ready" }]);
});

it("cuts PCM at device clock gaps and preserves exact sample positions", () => {
  let Processor: any;
  const scope = {
    sampleRate: 48_000,
    currentFrame: 0,
    AudioWorkletProcessor: class {
      port: any = {};
    },
    registerProcessor: (_: string, ctor: any) => {
      Processor = ctor;
    },
  };
  runInNewContext(
    readFileSync("apps/client/src/recorder/pcm-worklet.js", "utf8"),
    scope,
  );
  const messages: any[] = [];
  const processor = new Processor({ processorOptions: { channels: 1 } });
  processor.port.onmessage({
    data: {
      type: "connect",
      port: {
        start() {},
        postMessage(message: any) {
          messages.push(message);
        },
      },
    },
  });
  const block = new Float32Array(128).fill(0.25);
  processor.process([[block]]);
  scope.currentFrame = 128;
  processor.process([[block]]);
  scope.currentFrame = 768;
  processor.process([[block]]);
  processor.port.onmessage({ data: { type: "stop" } });
  const pcm = messages.filter((m) => m.type === "pcm");
  expect(pcm.map((m) => [m.firstFrame, m.frames])).toEqual([
    [0, 256],
    [768, 128],
  ]);
  expect(
    new Float32Array(pcm[0].buffer).slice(0, 256).every((v) => v === 0.25),
  ).toBe(true);
  expect(messages.at(-1).type).toBe("end");
});

it("keeps all render quanta across repeated and partly overlapping clock values", () => {
  let Processor: any;
  const scope = {
    sampleRate: 48_000,
    currentFrame: 0,
    AudioWorkletProcessor: class {
      port: any = {};
    },
    registerProcessor: (_: string, ctor: any) => {
      Processor = ctor;
    },
  };
  runInNewContext(
    readFileSync("apps/client/src/recorder/pcm-worklet.js", "utf8"),
    scope,
  );
  const messages: any[] = [];
  const processor = new Processor({ processorOptions: { channels: 1 } });
  processor.port.onmessage({
    data: {
      type: "connect",
      port: {
        start() {},
        postMessage(m: any) {
          messages.push(m);
        },
      },
    },
  });
  const block = new Float32Array(128).fill(0.5);
  processor.process([[block]]);
  processor.process([[block]]); // Stale clock; another 128 PCM frames.
  scope.currentFrame = 64;
  processor.process([[block]]); // Still stale; all PCM frames are new.
  scope.currentFrame = 384;
  processor.process([[block]]);
  processor.port.onmessage({ data: { type: "stop" } });
  const pcm = messages.filter((m) => m.type === "pcm");
  expect(pcm.map((m) => [m.firstFrame, m.frames])).toEqual([[0, 512]]);
  expect(messages.at(-1)).toMatchObject({
    type: "end",
    clockCorrections: 2,
    maxClockLagFrames: 192,
    clockLagFrames: 0,
  });
  expect(messages.some((m) => m.type === "error")).toBe(false);
});

it("retains a short burst of separate clock gaps while earlier blocks are still being stored", () => {
  let Processor: any;
  const scope = {
    sampleRate: 48_000,
    currentFrame: 0,
    AudioWorkletProcessor: class {
      port: any = {};
    },
    registerProcessor: (_: string, ctor: any) => {
      Processor = ctor;
    },
  };
  runInNewContext(
    readFileSync("apps/client/src/recorder/pcm-worklet.js", "utf8"),
    scope,
  );
  const messages: any[] = [];
  const processor = new Processor({ processorOptions: { channels: 1 } });
  processor.port.onmessage({
    data: {
      type: "connect",
      port: {
        start() {},
        postMessage(message: any) {
          messages.push(message);
        },
      },
    },
  });
  for (let index = 0; index < 5; index++) {
    scope.currentFrame = index * 256;
    processor.process([[new Float32Array(128).fill(0.25)]]);
  }
  processor.port.onmessage({ data: { type: "stop" } });
  expect(messages.some((m) => m.type === "error")).toBe(false);
  expect(
    messages.filter((m) => m.type === "pcm").map((m) => m.firstFrame),
  ).toEqual([0, 256, 512, 768, 1024]);
  expect(messages.at(-1).type).toBe("end");
});

function processorFixture() {
  let Processor: any;
  const scope = {
    sampleRate: 48_000,
    currentFrame: 480_000,
    AudioWorkletProcessor: class {
      port: any = {};
    },
    registerProcessor: (_: string, ctor: any) => {
      Processor = ctor;
    },
  };
  runInNewContext(
    readFileSync("apps/client/src/recorder/pcm-worklet.js", "utf8"),
    scope,
  );
  const messages: any[] = [];
  const target = {
    onmessage: null as any,
    start() {},
    postMessage(message: any) {
      messages.push(message);
    },
  };
  const processor = new Processor({ processorOptions: { channels: 2 } });
  processor.port.onmessage({ data: { type: "connect", port: target } });
  return { scope, processor, target, messages };
}

it("preserves one minute of PCM and silence with recurring stale clocks, variable render sizes, and recycled buffers", () => {
  const { scope, processor, target, messages } = processorFixture();
  let frame = 0,
    captured = 0,
    corrections = 0,
    previousClock = 0;
  const silentRanges: [number, number][] = [];
  target.postMessage = (message: any) => {
    if (message.type !== "pcm") {
      messages.push(message);
      return;
    }
    expect(message.firstFrame).toBe(480_000 + captured);
    const pcm = new Float32Array(message.buffer);
    for (let i = 0; i < message.frames; i++) {
      const sample = captured + i;
      const silent = silentRanges.some(
        ([start, end]) => sample >= start && sample < end,
      );
      const value = silent ? 0 : sample + 1;
      if (pcm[i * 2] !== value || pcm[i * 2 + 1] !== -value)
        throw new Error(`PCM changed at sample ${sample}`);
    }
    captured += message.frames;
    target.onmessage({ data: { type: "recycle", buffer: message.buffer } });
  };
  for (let quantum = 0; frame < 48_000 * 60; quantum++) {
    const count = [128, 256, 64, 512][quantum % 4];
    scope.currentFrame =
      480_000 + (quantum % 113 === 37 ? previousClock : frame);
    if (quantum % 113 === 37) corrections++;
    previousClock = frame;
    const silent = quantum % 499 === 0;
    if (silent) silentRanges.push([frame, frame + count]);
    const left = Float32Array.from({ length: count }, (_, i) => frame + i + 1);
    const right = Float32Array.from(left, (value) => -value);
    processor.process(silent ? [[]] : [[left, right]], [
      [new Float32Array(count)],
    ]);
    frame += count;
  }
  processor.port.onmessage({ data: { type: "stop" } });
  expect(captured).toBe(frame);
  expect(messages).toEqual([
    expect.objectContaining({
      type: "end",
      clockCorrections: corrections,
      clockLagFrames: 0,
    }),
  ]);
});

it("stops a clock reset over one second and keeps the preceding PCM", () => {
  const { scope, processor, messages } = processorFixture();
  processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  scope.currentFrame -= 48_000;
  processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  expect(messages.map((message) => message.type)).toEqual(["pcm", "error"]);
  expect(messages[0]).toMatchObject({ firstFrame: 480_000, frames: 128 });
  expect(messages[1].message).toContain("mehr als eine Sekunde");
  expect(processor.active).toBe(false);
});
