// Read only the report already collected for adaptation; no extra getStats call.
export function summarizeRtc(report: RTCStatsReport) {
  let pair: Record<string, unknown> | undefined;
  let transport: Record<string, unknown> | undefined;
  const media: Record<string, unknown>[] = [];
  report.forEach((stat) => {
    if (stat.type === "transport" && stat.selectedCandidatePairId) {
      pair = report.get(stat.selectedCandidatePairId);
      transport = {
        dtlsState: stat.dtlsState,
        iceRole: stat.iceRole,
        dtlsRole: stat.dtlsRole,
        tlsVersion: stat.tlsVersion,
        dtlsCipher: stat.dtlsCipher,
      };
    }
    if (
      !pair &&
      stat.type === "candidate-pair" &&
      stat.state === "succeeded" &&
      stat.nominated
    )
      pair = stat;
    if (
      ["inbound-rtp", "outbound-rtp", "remote-inbound-rtp"].includes(
        stat.type,
      ) &&
      media.length < 12
    ) {
      const row: Record<string, unknown> = {};
      for (const key of [
        "id",
        "type",
        "kind",
        "timestamp",
        "bytesSent",
        "bytesReceived",
        "packetsSent",
        "packetsReceived",
        "packetsLost",
        "jitter",
        "framesEncoded",
        "framesDecoded",
        "framesDropped",
        "freezeCount",
        "totalFreezesDuration",
        "concealedSamples",
        "totalSamplesReceived",
        "roundTripTime",
        "totalEncodeTime",
        "qualityLimitationReason",
      ])
        if (stat[key] !== undefined) row[key] = stat[key];
      media.push(row);
    }
  });
  const candidate = (id: unknown) => {
    const stat = typeof id === "string" ? report.get(id) : undefined;
    return stat
      ? {
          candidateType: stat.candidateType,
          protocol: stat.protocol,
          address: stat.address ?? stat.ip,
          port: stat.port,
          relayProtocol: stat.relayProtocol,
          url: stat.url,
        }
      : null;
  };
  const local = candidate(pair?.localCandidateId);
  const remote = candidate(pair?.remoteCandidateId);
  return {
    at: new Date().toISOString(),
    media,
    transport,
    selectedPair: pair
      ? {
          route:
            local?.candidateType === "relay" ||
            remote?.candidateType === "relay"
              ? "TURN"
              : "direct",
          state: pair.state,
          currentRoundTripTime: pair.currentRoundTripTime,
          availableOutgoingBitrate: pair.availableOutgoingBitrate,
          bytesSent: pair.bytesSent,
          bytesReceived: pair.bytesReceived,
          local,
          remote,
        }
      : null,
  };
}

// Display the selected route, not the configured ICE servers. A direct host
// connection needs no STUN mapping, even when a STUN server is configured.
export function describeIceRoute(stats?: ReturnType<typeof summarizeRtc>) {
  const pair = stats?.selectedPair;
  if (!pair || pair.state !== "succeeded") return null;
  const types = [pair.local?.candidateType, pair.remote?.candidateType];
  if (types.includes("relay"))
    return {
      label: "TURN",
      description: "Verschlüsselte Verbindung über den TURN-Relay.",
    };
  if (types.includes("srflx") || types.includes("prflx"))
    return {
      label: "STUN",
      description: "Direkte Verbindung mit NAT-Erkennung über STUN.",
    };
  if (types.every((type) => type === "host"))
    return {
      label: "Direkt",
      description:
        "Direkte Verbindung ohne Relay und ohne STUN-Adressabbildung.",
    };
  return null;
}
