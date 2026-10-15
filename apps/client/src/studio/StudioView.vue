<script setup lang="ts">
import { computed } from "vue";
import {
  Camera,
  CameraOff,
  Circle,
  Mic,
  MicOff,
  Pause,
  Play,
  ScreenShare,
  ScreenShareOff,
  Square,
} from "@lucide/vue";
import { Alert, AlertDescription } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";
import Disclosure from "@/ui/patterns/Disclosure.vue";
import StatusBadge from "@/ui/patterns/StatusBadge.vue";
import { describeIceRoute } from "../live/statistics";
import StreamVideo from "./StreamVideo.vue";
import {
  act,
  duration,
  initial,
  statusLabel,
  statusTone,
  studio,
} from "./state";

const dev = import.meta.env.DEV;
const localCamera = computed(() =>
  studio.value.capture.sources.find(
    (s) => s.id === studio.value.capture.selectedCamera,
  ),
);
const remotes = computed(() => [...studio.value.mesh.remotes.values()]);
const issue = computed(
  () => remotes.value.find((r) => r.connectionIssue)?.connectionIssue,
);
const screens = computed(() => [
  ...studio.value.capture.sources
    .filter((s) => s.kind === "screen")
    .map((s) => ({ id: s.id, stream: s.stream, name: "Dein Bildschirm" })),
  ...remotes.value
    .filter((r) => r.peer.media.sharing && !r.peer.media.livePaused)
    .map((r) => ({ id: r.id, stream: r.screen, name: r.peer.name })),
]);
const progress = computed(() => {
  const sources =
    (studio.value.recording || studio.value.lastRecording)?.status.sources ??
    [];
  return sources.length
    ? {
        saved: Math.min(...sources.map((s) => s.savedSeconds)),
        captured: Math.max(...sources.map((s) => s.capturedSeconds)),
      }
    : { saved: 0, captured: 0 };
});
const active = computed(
  () => !!studio.value.recording || studio.value.groupActive,
);
const blocked = computed(() => {
  return studio.value.startBlocked;
});
const failedSources = computed(
  () => studio.value.recording?.status.sources.filter((s) => s.error) || [],
);
const diagnostics = () =>
  JSON.stringify(
    remotes.value.map((r) => ({
      name: r.peer.name,
      connection: r.pc.connectionState,
      ice: r.pc.iceConnectionState,
      gathering: r.pc.iceGatheringState,
      signaling: r.pc.signalingState,
      local: r.pc.localDescription?.type,
      remote: r.pc.remoteDescription?.type,
      makingOffer: r.makingOffer,
      tracks: r.stream.getTracks().map((t) => ({
        kind: t.kind,
        muted: t.muted,
        enabled: t.enabled,
        state: t.readyState,
      })),
      transceivers: r.pc.getTransceivers().map((t) => ({
        mid: t.mid,
        direction: t.direction,
        current: t.currentDirection,
        sender: t.sender.track?.kind,
        receiver: t.receiver.track.kind,
        muted: t.receiver.track.muted,
      })),
      localCandidates: r.pc.localDescription?.sdp.match(/a=candidate:.*/g),
      remoteCandidates: r.pc.remoteDescription?.sdp.match(/a=candidate:.*/g),
      control: r.control?.readyState,
      files: r.files?.readyState,
    })),
    null,
    2,
  );
const restartIce = () => {
  for (const r of studio.value.mesh.remotes.values()) r.pc.restartIce();
};
const pill =
  "inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white backdrop-blur-sm";
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4 p-4 md:p-6">
    <Alert v-if="issue" role="status">
      <AlertDescription class="flex flex-wrap items-center gap-3">
        <span class="flex-1">{{ issue }}</span>
        <Button variant="outline" size="sm" @click="studio.mesh.retry()"
          >Erneut verbinden</Button
        >
      </AlertDescription>
    </Alert>
    <Alert
      v-if="failedSources.length"
      role="alert"
      class="border-destructive text-destructive"
    >
      <AlertDescription>
        Aufnahmefehler:
        {{ failedSources.map((s) => `${s.label}: ${s.error}`).join(" · ") }}.
        Die übrigen Spuren laufen weiter. Bereits gesicherte Dateien bleiben
        erhalten.
      </AlertDescription>
    </Alert>
    <Disclosure v-if="dev && remotes.length" title="Verbindungsdiagnose">
      <pre class="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">{{
        diagnostics()
      }}</pre>
      <Button variant="outline" size="sm" class="mt-2" @click="restartIce"
        >ICE neu versuchen</Button
      >
    </Disclosure>

    <div
      class="grid min-w-0 flex-1 content-center items-center gap-3"
      :class="remotes.length ? 'sm:grid-cols-2' : 'mx-auto w-full max-w-5xl'"
    >
      <article
        class="relative aspect-video min-h-0 min-w-0 overflow-hidden rounded-xl bg-neutral-950 dark:bg-neutral-900"
      >
        <StreamVideo
          :stream="localCamera?.stream || null"
          muted
          :hidden="studio.capture.camMuted"
        />
        <div
          v-if="!localCamera || studio.capture.camMuted"
          class="absolute inset-0 grid place-items-center text-neutral-500"
        >
          <CameraOff
            v-if="studio.capture.camMuted"
            class="size-8"
            aria-label="Kamera aus"
          />
          <Camera v-else class="size-8" aria-label="Keine Kamera" />
        </div>
        <div class="absolute top-3 left-3 flex gap-1.5">
          <span v-if="studio.recording" :class="pill"
            ><span
              class="size-2 animate-pulse rounded-full bg-red-500"
              aria-hidden="true"
            />REC</span
          >
          <span v-if="localCamera?.synthetic" :class="pill">Testquelle</span>
        </div>
        <div class="absolute right-3 bottom-3 left-3 flex justify-between">
          <span :class="pill"
            >{{ studio.name || "Du" }}
            <MicOff
              v-if="studio.capture.micMuted"
              class="size-3"
              aria-label="Stumm"
          /></span>
          <span v-if="localCamera" :class="pill" class="tabular-nums"
            >{{ localCamera.settings.height }}p</span
          >
        </div>
      </article>

      <article
        v-for="remote in remotes"
        :key="remote.id"
        class="relative aspect-video overflow-hidden rounded-xl bg-neutral-950 dark:bg-neutral-900"
      >
        <StreamVideo
          :stream="remote.stream"
          :hidden="remote.peer.media.camMuted || remote.peer.media.livePaused"
        />
        <div
          v-if="
            remote.peer.media.camMuted ||
            remote.peer.media.livePaused ||
            remote.connection !== 'connected'
          "
          class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-neutral-400"
        >
          <span
            class="grid size-14 place-items-center rounded-full bg-neutral-800 text-xl font-medium text-neutral-200"
            >{{ initial(remote.peer.name) }}</span
          >
          <span v-if="remote.peer.media.livePaused" class="text-xs"
            >Live pausiert</span
          >
          <span v-else-if="remote.connection !== 'connected'" class="text-xs"
            >Verbindet …</span
          >
        </div>
        <div class="absolute right-3 bottom-3 left-3 flex justify-between">
          <span :class="pill"
            >{{ remote.peer.name }}
            <MicOff
              v-if="remote.peer.media.micMuted"
              class="size-3"
              aria-label="Stumm"
          /></span>
          <span
            v-if="remote.connection === 'connected'"
            :class="pill"
            class="tabular-nums"
            :title="describeIceRoute(remote.telemetryStats)?.description"
            ><span v-if="describeIceRoute(remote.telemetryStats)"
              >{{ describeIceRoute(remote.telemetryStats)?.label }} ·</span
            >{{ remote.stats.rtt.toFixed(0) }} ms</span
          >
        </div>
      </article>
    </div>

    <div v-if="screens.length" class="grid gap-3 sm:grid-cols-2">
      <figure
        v-for="screen in screens"
        :key="screen.id"
        class="relative aspect-video overflow-hidden rounded-xl bg-neutral-950 dark:bg-neutral-900"
      >
        <StreamVideo :stream="screen.stream" muted />
        <figcaption :class="pill" class="absolute bottom-3 left-3">
          <ScreenShare class="size-3" aria-hidden="true" />{{ screen.name }}
        </figcaption>
      </figure>
    </div>

    <div
      class="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border bg-card p-2 sm:justify-center"
    >
      <div class="order-1 flex items-center gap-2 px-2" aria-live="polite">
        <span
          v-if="studio.recording"
          class="size-2 animate-pulse rounded-full bg-red-500"
          aria-hidden="true"
        />
        <span class="font-mono text-sm tabular-nums">{{
          duration(studio.recording?.elapsedSeconds ?? progress.captured)
        }}</span>
        <span
          v-if="studio.recording"
          class="text-xs text-muted-foreground tabular-nums"
          :title="`${duration(progress.saved)} sicher geschrieben`"
          :class="{ 'text-destructive': failedSources.length }"
          >{{ duration(progress.saved) }} in allen Spuren gesichert{{
            failedSources.length ? " · Spur ausgefallen" : ""
          }}</span
        >
        <span
          v-else-if="studio.pendingStart"
          class="text-xs text-muted-foreground"
          >Startet …</span
        >
        <StatusBadge
          v-else-if="studio.lastRecording"
          :label="statusLabel(studio.lastRecording.status.state)"
          :tone="statusTone(studio.lastRecording.status.state)"
        />
      </div>
      <div
        class="order-3 flex w-full justify-center gap-1.5 sm:order-2 sm:w-auto"
      >
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="outline"
              size="icon-lg"
              class="rounded-full"
              :class="{ 'text-destructive': studio.capture.micMuted }"
              :aria-label="
                studio.capture.micMuted ? 'Mikrofon an' : 'Stummschalten'
              "
              :aria-pressed="studio.capture.micMuted"
              @click="act(() => studio.mute('audio'))"
            >
              <MicOff v-if="studio.capture.micMuted" aria-hidden="true" />
              <Mic v-else aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{
            studio.capture.micMuted ? "Mikrofon an" : "Stummschalten"
          }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="outline"
              size="icon-lg"
              class="rounded-full"
              :class="{ 'text-destructive': studio.capture.camMuted }"
              :aria-label="studio.capture.camMuted ? 'Kamera an' : 'Kamera aus'"
              :aria-pressed="studio.capture.camMuted"
              @click="act(() => studio.mute('video'))"
            >
              <CameraOff v-if="studio.capture.camMuted" aria-hidden="true" />
              <Camera v-else aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{
            studio.capture.camMuted ? "Kamera an" : "Kamera aus"
          }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              :variant="studio.capture.screenTrack ? 'default' : 'outline'"
              size="icon-lg"
              class="rounded-full"
              :aria-label="
                studio.capture.screenTrack
                  ? 'Freigabe beenden'
                  : 'Bildschirm teilen'
              "
              :aria-pressed="!!studio.capture.screenTrack"
              @click="act(() => studio.screen())"
            >
              <ScreenShareOff
                v-if="studio.capture.screenTrack"
                aria-hidden="true"
              />
              <ScreenShare v-else aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{
            studio.capture.screenTrack
              ? "Freigabe beenden"
              : "Bildschirm teilen"
          }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              :variant="studio.mesh.paused ? 'default' : 'outline'"
              size="icon-lg"
              class="rounded-full"
              :aria-label="
                studio.mesh.paused ? 'Live fortsetzen' : 'Live pausieren'
              "
              :aria-pressed="studio.mesh.paused"
              @click="act(() => studio.pauseLive())"
            >
              <Play v-if="studio.mesh.paused" aria-hidden="true" />
              <Pause v-else aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{
            studio.mesh.paused ? "Live fortsetzen" : "Live pausieren"
          }}</TooltipContent>
        </Tooltip>
      </div>
      <span
        class="order-3 hidden h-6 w-px bg-border sm:block"
        aria-hidden="true"
      />
      <Tooltip :disabled="!blocked && !active">
        <TooltipTrigger as-child>
          <span class="order-2 sm:order-4" :tabindex="blocked ? 0 : undefined">
            <Button
              :variant="active ? 'destructive' : 'default'"
              size="lg"
              class="rounded-full"
              :disabled="!!blocked"
              @click="act(() => studio.record())"
            >
              <Square v-if="active" fill="currentColor" aria-hidden="true" />
              <Circle
                v-else
                class="text-red-500"
                fill="currentColor"
                aria-hidden="true"
              />
              {{ active ? "Stoppen" : "Aufnehmen" }}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{
          blocked ||
          (studio.isHost ? "Aufnahme für alle stoppen" : "Lokal stoppen")
        }}</TooltipContent>
      </Tooltip>
    </div>
    <p
      v-if="blocked && !active"
      class="text-center text-sm text-muted-foreground"
      role="status"
    >
      {{ blocked }}
    </p>
  </div>
</template>
