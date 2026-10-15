import { expect, it } from "vitest";
import {
  describeIceRoute,
  summarizeRtc,
} from "../apps/client/src/live/statistics.js";

function summary(local: string, remote: string, state = "succeeded") {
  return summarizeRtc(
    new Map([
      ["local", { id: "local", type: "local-candidate", candidateType: local }],
      [
        "remote",
        { id: "remote", type: "remote-candidate", candidateType: remote },
      ],
      [
        "pair",
        {
          id: "pair",
          type: "candidate-pair",
          localCandidateId: "local",
          remoteCandidateId: "remote",
          state,
        },
      ],
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ]) as unknown as RTCStatsReport,
  );
}

it.each([
  ["host", "host", "Direkt"],
  ["host", "srflx", "STUN"],
  ["prflx", "host", "STUN"],
  ["srflx", "srflx", "STUN"],
  ["relay", "host", "TURN"],
  ["srflx", "relay", "TURN"],
  ["relay", "relay", "TURN"],
])("labels the selected %s/%s route as %s", (local, remote, label) => {
  expect(describeIceRoute(summary(local, remote))?.label).toBe(label);
});

it("does not invent a route before a successful selected pair is available", () => {
  expect(describeIceRoute()).toBeNull();
  expect(describeIceRoute(summary("host", "host", "in-progress"))).toBeNull();
  expect(describeIceRoute(summary("", ""))).toBeNull();
  expect(
    describeIceRoute(summarizeRtc(new Map() as unknown as RTCStatsReport)),
  ).toBeNull();
});
