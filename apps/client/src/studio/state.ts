import { customRef } from "vue";
import { studio as runtime } from "../core/runtime.js";
import type { ParticipantState } from "../core/sessions.js";

// The runtime owns recording objects outside Vue, so they are never proxied or remounted.
// Views read it through this ref and re-render on each runtime change. The runtime mutates
// its objects in place: derived values must read `studio.value` themselves, because a computed
// that only reads another computed's runtime object sees the same identity and stays stale.
export const studio = customRef<typeof runtime>((track, trigger) => {
  runtime.subscribe(trigger);
  return {
    get: () => {
      track();
      return runtime;
    },
    set: () => undefined,
  };
});

export const act = (fn: () => unknown) => {
  try {
    Promise.resolve(fn()).catch((error) => {
      if ((error as DOMException)?.name !== "AbortError") runtime.report(error);
    });
  } catch (error) {
    runtime.report(error);
  }
};

export const bytes = (value: number) =>
  value >= 1e9
    ? `${(value / 1e9).toFixed(2)} GB`
    : value >= 1e6
      ? `${(value / 1e6).toFixed(1)} MB`
      : `${Math.round(value / 1000)} kB`;
export const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
export const statusLabel = (value: string) =>
  ({
    recording: "Nimmt auf",
    finalizing: "Wird gesichert",
    saved: "Gesichert",
    partial: "Teilbestand",
    failed: "Fehler",
    offering: "Inventar kommt an",
    offered: "Bereit zur Übernahme",
    transferring: "Überträgt",
    paused: "Wartet auf Aufnahmeende / Ziel-PC",
    verifying: "Prüft Dateien",
    done: "Übernommen",
    error: "Unterbrochen",
  })[value] || value;
export const statusTone = (value: string) =>
  ["failed", "error"].includes(value)
    ? "bad"
    : ["partial", "paused"].includes(value)
      ? "warning"
      : ["saved", "done"].includes(value)
        ? "good"
        : "neutral";
export const initial = (name: string) => name.trim()[0]?.toUpperCase() || "?";
export const participantLabel = (value: ParticipantState) =>
  ({
    recording: "Nimmt auf",
    finalizing: "Wird gesichert",
    waiting: "Wartet auf Übertragung",
    sending: "Sendet an den Host",
    receiving: "Wird empfangen",
    done: "Vollständig",
    local: "Lokal gesichert",
    partial: "Teilbestand",
    failed: "Keine Originale",
  })[value];
export const participantTone = (value: ParticipantState) =>
  ({
    recording: "neutral",
    finalizing: "neutral",
    waiting: "warning",
    sending: "neutral",
    receiving: "neutral",
    done: "good",
    local: "good",
    partial: "warning",
    failed: "bad",
  })[value] as "neutral" | "warning" | "good" | "bad";
export const sessionTitle = (iso: string) =>
  new Date(iso).toLocaleString("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
