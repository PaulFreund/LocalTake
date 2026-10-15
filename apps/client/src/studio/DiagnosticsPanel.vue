<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Bug, Copy, Download, RefreshCw } from "@lucide/vue";
import { Button } from "@/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/ui/components/sheet";
import Disclosure from "@/ui/patterns/Disclosure.vue";
import StatusBadge from "@/ui/patterns/StatusBadge.vue";
import {
  collectDiagnostics,
  type DiagnosticReport,
} from "../core/diagnostics.js";
import { studio } from "./state";

const open = ref(false);
const report = ref<DiagnosticReport | null>(null);
const updating = ref(false);
const feedback = ref("");
const error = ref("");
let timer: ReturnType<typeof setInterval> | undefined;
let pending: Promise<DiagnosticReport | null> | null = null;
const json = computed(() => JSON.stringify(report.value, null, 2));
const time = computed(() =>
  report.value
    ? new Date(report.value.generatedAt).toLocaleTimeString("de-DE")
    : "",
);

function refresh(): Promise<DiagnosticReport | null> {
  if (pending) return pending;
  updating.value = true;
  pending = collectDiagnostics(studio.value)
    .then((value) => {
      report.value = value;
      error.value = "";
      return value;
    })
    .catch((cause) => {
      error.value = `Diagnose konnte nicht gelesen werden: ${cause instanceof Error ? cause.message : String(cause)}`;
      return null;
    })
    .finally(() => {
      updating.value = false;
      pending = null;
    });
  return pending;
}
watch(open, (value) => {
  clearInterval(timer);
  if (!value) return;
  feedback.value = "";
  void refresh();
  // Statistics are local reads; no probes, recordings or server requests.
  timer = setInterval(() => void refresh(), 2500);
});
onBeforeUnmount(() => clearInterval(timer));

async function copy() {
  const value = await refresh();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    feedback.value = "Diagnose kopiert.";
  } catch {
    feedback.value =
      "Kopieren nicht erlaubt. Bitte den JSON-Bericht herunterladen.";
  }
}
async function download() {
  const value = await refresh();
  if (!value) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `localtake-diagnose-${value.generatedAt.replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  feedback.value = "Diagnose heruntergeladen.";
}
function address(candidate: Record<string, unknown> | null | undefined) {
  if (!candidate) return "–";
  const ip = String(candidate.address ?? candidate.ip ?? "unbekannt");
  return `${ip.includes(":") ? `[${ip}]` : ip}:${candidate.port ?? "?"}`;
}
const turnConfigured = computed(() =>
  report.value?.iceServers.some((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) =>
      /^turns?:/i.test(url),
    ),
  ),
);
</script>

<template>
  <Sheet v-model:open="open">
    <SheetTrigger as-child>
      <Button
        variant="ghost"
        size="sm"
        class="max-sm:size-8 max-sm:p-0"
        aria-label="Diagnose öffnen"
      >
        <Bug aria-hidden="true" />
        <span class="max-sm:sr-only">Diagnose</span>
      </Button>
    </SheetTrigger>
    <SheetContent side="right" class="w-full gap-0 sm:max-w-2xl">
      <SheetHeader class="shrink-0 border-b pr-12">
        <SheetTitle>Diagnose</SheetTitle>
        <SheetDescription
          >Verbindung, Netzwerk, Geräte und Fehler dieses
          Browsers.</SheetDescription
        >
      </SheetHeader>
      <div
        class="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3"
      >
        <Button
          variant="outline"
          size="sm"
          :disabled="!report || updating"
          @click="copy"
        >
          <Copy aria-hidden="true" /> Kopieren
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="!report || updating"
          @click="download"
        >
          <Download aria-hidden="true" /> JSON herunterladen
        </Button>
        <Button variant="ghost" size="sm" :disabled="updating" @click="refresh">
          <RefreshCw :class="updating && 'animate-spin'" aria-hidden="true" />
          Aktualisieren
        </Button>
        <span class="text-xs text-muted-foreground">{{
          time ? `Stand ${time}` : "Wird gelesen …"
        }}</span>
      </div>
      <div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-sm">
        <p v-if="feedback" role="status" class="text-muted-foreground">
          {{ feedback }}
        </p>
        <p v-if="error" role="alert" class="text-destructive">{{ error }}</p>
        <template v-if="report">
          <section class="space-y-3" aria-label="Verbindungsüberblick">
            <div class="flex items-center justify-between gap-2">
              <h3 class="font-medium">Verbindungsüberblick</h3>
              <StatusBadge
                :label="
                  report.browser.online ? 'Browser online' : 'Browser offline'
                "
                :tone="report.browser.online ? 'good' : 'bad'"
              />
            </div>
            <dl
              class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border p-3 text-xs"
            >
              <dt class="text-muted-foreground">Raumverbindung</dt>
              <dd>
                {{
                  report.signaling.authenticated
                    ? "Angemeldet"
                    : "Nicht angemeldet"
                }}
                · WebSocket {{ report.signaling.socket }}
              </dd>
              <dt class="text-muted-foreground">Wiederverbindungen</dt>
              <dd>{{ report.signaling.reconnectAttempts }}</dd>
              <dt class="text-muted-foreground">TURN konfiguriert</dt>
              <dd>
                {{
                  report.signaling.lastWelcomeAt
                    ? turnConfigured
                      ? "Ja"
                      : "Nein"
                    : "Noch unbekannt"
                }}
              </dd>
              <dt class="text-muted-foreground">Verbindungsmodus</dt>
              <dd>
                {{
                  report.iceTransportPolicy === "relay"
                    ? "Nur TURN – Testmodus"
                    : turnConfigured
                      ? "Direktverbindung mit TURN als Ausweichweg"
                      : "Direktverbindung"
                }}
              </dd>
              <dt class="text-muted-foreground">STUN / TURN</dt>
              <dd class="min-w-0 break-all">
                <template
                  v-for="(server, index) in report.iceServers"
                  :key="index"
                >
                  <div>
                    {{
                      Array.isArray(server.urls)
                        ? server.urls.join(", ")
                        : server.urls
                    }}
                  </div>
                </template>
                <span v-if="!report.iceServers.length"
                  >Noch keine Konfiguration vom Raum erhalten</span
                >
              </dd>
              <dt class="text-muted-foreground">Version</dt>
              <dd class="min-w-0 break-all">
                {{ report.app.build?.version || "unbekannt" }} ·
                {{ report.app.build?.revision || "ohne Git-Revision" }} ·
                {{ report.app.build?.mode }}
              </dd>
              <dt class="text-muted-foreground">Browser</dt>
              <dd class="min-w-0 break-all">{{ report.browser.userAgent }}</dd>
              <dt class="text-muted-foreground">Mikrofon / Kamera</dt>
              <dd>
                {{ report.browser.permissions.microphone }} /
                {{ report.browser.permissions.camera }}
              </dd>
            </dl>
          </section>
          <section class="space-y-3" aria-label="Automatische Diagnose">
            <h3 class="font-medium">Automatische Diagnose</h3>
            <p class="text-xs text-muted-foreground">
              {{
                report.telemetry?.enabled
                  ? "Kompakte Ereignisse und Statuswerte werden im Hintergrund an den Server gesendet, regulär alle 30 Sekunden. Alte Serverprotokolle werden automatisch gelöscht; Diagnose und App-Logs bleiben zusammen unter 1 GB."
                  : "Der automatische Versand startet, sobald der Raumserver ihn freigibt."
              }}
            </p>
            <dl
              v-if="report.telemetry?.enabled"
              class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border p-3 text-xs"
            >
              <dt class="text-muted-foreground">Letzte Annahme</dt>
              <dd>
                {{
                  report.telemetry.lastAcceptedAt
                    ? new Date(
                        report.telemetry.lastAcceptedAt,
                      ).toLocaleTimeString("de-DE")
                    : "Noch keine"
                }}
              </dd>
              <dt class="text-muted-foreground">Warteschlange / verworfen</dt>
              <dd>
                {{ report.telemetry.queued }} / {{ report.telemetry.dropped }}
              </dd>
              <dt class="text-muted-foreground">Browserkennung</dt>
              <dd class="break-all">{{ report.telemetry.pageId }}</dd>
              <template v-if="report.telemetry.lastError">
                <dt class="text-muted-foreground">Versand</dt>
                <dd class="break-words">
                  {{ report.telemetry.lastError }}. Aufnahme und Verbindung
                  laufen unabhängig davon weiter.
                </dd>
              </template>
            </dl>
          </section>
          <section class="space-y-3" aria-label="Gegenstellen">
            <h3 class="font-medium">Gegenstellen</h3>
            <p v-if="!report.peers.length" class="text-muted-foreground">
              Noch keine Gegenstelle verbunden. Die Diagnose kann bereits
              kopiert oder gespeichert werden.
            </p>
            <article
              v-for="peer in report.peers"
              :key="peer.id"
              class="space-y-3 rounded-lg border p-3"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h4 class="font-medium">{{ peer.name }}</h4>
                <StatusBadge
                  :label="peer.connection"
                  :tone="
                    peer.connection === 'connected'
                      ? 'good'
                      : ['failed', 'disconnected'].includes(peer.connection)
                        ? 'bad'
                        : 'warning'
                  "
                />
              </div>
              <p>{{ peer.diagnosis }}</p>
              <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                <dt class="text-muted-foreground">ICE / Sammlung</dt>
                <dd>{{ peer.ice }} / {{ peer.gathering }}</dd>
                <dt class="text-muted-foreground">Signalisierung</dt>
                <dd>{{ peer.signaling }}</dd>
                <dt class="text-muted-foreground">Angebot / Antwort</dt>
                <dd>
                  Lokal {{ peer.descriptions.local?.type || "fehlt" }} ·
                  Gegenstelle {{ peer.descriptions.remote?.type || "fehlt" }}
                </dd>
                <dt class="text-muted-foreground">Steuer- / Dateikanal</dt>
                <dd>
                  {{ peer.channels.control?.readyState || "fehlt" }} /
                  {{ peer.channels.files?.readyState || "fehlt" }}
                </dd>
                <dt class="text-muted-foreground">Netzwerkroute</dt>
                <dd>
                  {{
                    peer.selectedPair?.route === "TURN"
                      ? "Über TURN"
                      : peer.selectedPair?.route === "direct"
                        ? "Direkt"
                        : "Noch keine ausgewählt"
                  }}
                </dd>
                <template v-if="peer.selectedPair">
                  <dt class="text-muted-foreground">Kandidatentypen</dt>
                  <dd>
                    {{ peer.selectedPair.local?.candidateType || "?" }} ↔
                    {{ peer.selectedPair.remote?.candidateType || "?" }} ·
                    {{ peer.selectedPair.local?.protocol || "?" }}
                  </dd>
                  <dt class="text-muted-foreground">Lokale Adresse</dt>
                  <dd class="min-w-0 break-all">
                    {{ address(peer.selectedPair.local) }}
                  </dd>
                  <dt class="text-muted-foreground">Gegenstelle</dt>
                  <dd class="min-w-0 break-all">
                    {{ address(peer.selectedPair.remote) }}
                  </dd>
                </template>
              </dl>
              <p v-if="peer.statsError" class="text-xs text-muted-foreground">
                {{ peer.statsError }}
              </p>
              <Disclosure title="ICE-Kandidaten, SDP und Medienstatistik">
                <pre
                  class="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs"
                  >{{ JSON.stringify(peer, null, 2) }}</pre>
              </Disclosure>
            </article>
          </section>
          <section
            v-if="report.currentError"
            class="rounded-lg border border-destructive/30 p-3"
            aria-label="Aktueller Fehler"
          >
            <h3 class="mb-2 font-medium">Aktueller Fehler</h3>
            <p class="break-words text-destructive">
              {{ report.currentError }}
            </p>
          </section>
          <Disclosure
            :title="`Ereignisverlauf (${report.events.length})`"
            variant="card"
          >
            <p
              v-if="report.droppedEvents"
              class="mb-2 text-xs text-muted-foreground"
            >
              {{ report.droppedEvents }} ältere Ereignisse wurden verworfen.
            </p>
            <pre
              class="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs"
              >{{ JSON.stringify(report.events, null, 2) }}</pre>
          </Disclosure>
          <Disclosure title="Vollständiger Diagnosebericht" variant="card">
            <pre
              class="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 text-xs"
              >{{ json }}</pre>
          </Disclosure>
          <p class="text-xs text-muted-foreground">
            Der vollständige Bericht wird lokal gesammelt und hier alle 2,5
            Sekunden aktualisiert. Der automatische Versand enthält kompakte
            Diagnosedaten, keine Medien, Chats oder vollständigen SDP-Daten.
            Netzwerkadressen können enthalten sein. Zugangstoken und
            ICE-Passwörter sind ausgeblendet.
          </p>
        </template>
      </div>
    </SheetContent>
  </Sheet>
</template>
