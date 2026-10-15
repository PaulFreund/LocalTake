import { describe, expect, it } from "vitest";
import { SessionClock } from "../apps/client/src/core/clock.js";
describe("session clock", () => {
  it("estimates offset and drift while filtering slow asymmetric samples", () => {
    const clock = new SessionClock();
    for (let t = 0; t <= 120_000; t += 10_000) {
      const offset = 700 + t * 0.0001;
      clock.accept(t, t + 10 + offset, t + 12 + offset, t + 22, "epoch-a");
    }
    expect(clock.toSession(120_000) - 120_000).toBeCloseTo(712, 0);
    expect(clock.snapshot().drift).toBeCloseTo(1.0001, 5);
    clock.accept(121_000, 122_000, 122_001, 122_001, "epoch-a");
    expect(clock.toSession(122_000) - 122_000).toBeCloseTo(712.2, 0);
  });
  it("keeps the known timeline across a coordinator restart", () => {
    const clock = new SessionClock();
    clock.accept(1000, 1510, 1511, 1021, "old");
    const before = clock.toSession(5000);
    clock.accept(4990, 100, 101, 5011, "new");
    expect(clock.toSession(5000)).toBeCloseTo(before, 5);
  });
});
