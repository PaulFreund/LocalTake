import type { ClockMapping } from "../../../../packages/protocol/src/index.js";

type Probe = { local: number; offset: number; rtt: number };
/** NTP-style estimates, deliberately separate from unmeasured camera/input latency. */
export class SessionClock {
  private epoch = "offline";
  private probes: Probe[] = [];
  private continuityOffset = 0;
  private last: ClockMapping | null = null;
  accept(t1: number, t2: number, t3: number, t4: number, epoch: string) {
    const rtt = t4 - t1 - (t3 - t2);
    if (
      ![t1, t2, t3, t4, rtt].every(Number.isFinite) ||
      rtt < 0 ||
      rtt > 5000 ||
      t4 < t1 ||
      t3 < t2
    )
      return;
    const local = (t1 + t4) / 2;
    const offset = (t2 - t1 + (t3 - t4)) / 2;
    if (epoch !== this.epoch) {
      // Preserve an established session timeline when the signaling process restarts.
      this.continuityOffset = this.last
        ? this.toSession(local) - (local + offset)
        : 0;
      this.probes = [];
      this.epoch = epoch;
    }
    this.probes.push({ local, offset: offset + this.continuityOffset, rtt });
    this.probes = this.probes.slice(-120);
    this.last = this.fit(local);
  }
  private fit(now: number): ClockMapping {
    if (!this.probes.length)
      return {
        id: crypto.randomUUID(),
        epoch: this.epoch,
        localMs: now,
        offsetMs: 0,
        drift: 1,
        uncertaintyMs: 5000,
        samples: 0,
      };
    const minRtt = Math.min(...this.probes.map((p) => p.rtt));
    const selected = this.probes.filter((p) => p.rtt <= minRtt + 10);
    const meanX = selected.reduce((s, p) => s + p.local, 0) / selected.length;
    const meanY = selected.reduce((s, p) => s + p.offset, 0) / selected.length;
    const denominator = selected.reduce(
      (s, p) => s + (p.local - meanX) ** 2,
      0,
    );
    const span =
      Math.max(...selected.map((p) => p.local)) -
      Math.min(...selected.map((p) => p.local));
    const slope =
      span >= 30_000 && denominator > 0
        ? selected.reduce(
            (s, p) => s + (p.local - meanX) * (p.offset - meanY),
            0,
          ) / denominator
        : 0;
    const driftSlope = Math.abs(slope) <= 0.001 ? slope : 0;
    const residual = Math.max(
      ...selected.map((p) =>
        Math.abs(p.offset - (meanY + driftSlope * (p.local - meanX))),
      ),
    );
    return {
      id: crypto.randomUUID(),
      epoch: this.epoch,
      localMs: now,
      offsetMs: meanY + driftSlope * (now - meanX),
      drift: 1 + driftSlope,
      uncertaintyMs: minRtt / 2 + residual,
      samples: selected.length,
    };
  }
  snapshot(now = performance.now()): ClockMapping {
    return this.fit(now);
  }
  toSession(local: number): number {
    const m = this.last;
    return m ? m.localMs + m.offsetMs + (local - m.localMs) * m.drift : local;
  }
  toLocal(session: number): number {
    const m = this.last;
    return m
      ? m.localMs + (session - m.localMs - m.offsetMs) / m.drift
      : session;
  }
  serverToLocal(serverTime: number): number {
    return this.toLocal(serverTime + this.continuityOffset);
  }
}
