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
  it("stores the same server reference for a surviving page and a new page after restart", () => {
    const surviving = new SessionClock();
    surviving.accept(1000, 1510, 1511, 1021, "old");
    surviving.accept(4990, 100, 101, 5011, "new");
    const reopened = new SessionClock();
    reopened.accept(2990, 100, 101, 3011, "new");
    const oldPage = JSON.parse(JSON.stringify(surviving.snapshot(5000)));
    const newPage = JSON.parse(JSON.stringify(reopened.snapshot(3000)));
    expect(oldPage.epoch).toBe("new");
    expect(newPage.epoch).toBe("new");
    expect(oldPage.localMs + oldPage.offsetMs).toBeCloseTo(100, 5);
    expect(newPage.localMs + newPage.offsetMs).toBeCloseTo(100, 5);
    expect(surviving.serverToLocal(100)).toBeCloseTo(5000, 5);
    expect(reopened.serverToLocal(100)).toBeCloseTo(3000, 5);
  });
});
