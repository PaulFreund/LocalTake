<script setup lang="ts">
import { Camera, Mic, Radio, ScreenShare, X } from "@lucide/vue";
import { Button } from "@/ui/components/button";
import OptionSelect from "@/ui/patterns/OptionSelect.vue";
import type { CaptureSource } from "../capture/manager.js";
import { act, duration, statusLabel, studio } from "./state";

const props = defineProps<{
  source: CaptureSource;
  level: number;
  locked: boolean;
}>();
// Functions, not computeds: they read the runtime on every render, see state.ts.
const live = () => studio.value.capture.selectedCamera === props.source.id;
const status = () =>
  (studio.value.recording || studio.value.lastRecording)?.status.sources.find(
    (s) => s.trackId === props.source.id,
  );
const devices = () =>
  studio.value.devices.filter(
    (d) =>
      d.kind === (props.source.kind === "audio" ? "audioinput" : "videoinput"),
  );
// Synthetic or vanished devices are not enumerated; keep them selectable as-is.
const current = () => props.source.settings.deviceId || "";
const listed = () => devices().some((d) => d.deviceId === current());
const detail = () => {
  if (props.source.changing) return "Gerät wird gewechselt …";
  const s = props.source.settings;
  return props.source.kind === "audio"
    ? `${(s.sampleRate || 48000) / 1000} kHz · ${s.channelCount || 1} ch`
    : `${s.width}×${s.height} · ${Math.round(s.frameRate || 30)} fps`;
};
const choose = (deviceId: string) => {
  if (deviceId !== current())
    act(() => studio.value.switchSource(props.source.id, deviceId));
};
const showLive = () =>
  act(async () => {
    studio.value.capture.selectedCamera = props.source.id;
    await studio.value.mesh.refresh();
    studio.value.changed();
  });
const remove = () => {
  studio.value.capture.remove(props.source.id);
  studio.value.invalidate();
};
</script>

<template>
  <div
    class="flex items-start gap-2 rounded-md border p-2"
    :data-source-kind="source.kind"
    :data-source-slot="source.slotId || source.id"
    :class="{ 'border-destructive/50': source.track.readyState === 'ended' }"
  >
    <component
      :is="
        source.kind === 'audio'
          ? Mic
          : source.kind === 'screen'
            ? ScreenShare
            : Camera
      "
      class="mt-2 size-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <OptionSelect
        v-if="source.kind !== 'screen'"
        class="h-8 w-full"
        :aria-label="source.kind === 'audio' ? 'Mikrofon' : 'Kamera'"
        :model-value="current()"
        :disabled="locked || source.changing"
        @update:model-value="choose"
      >
        <option v-if="!listed()" :value="current()">{{ source.label }}</option>
        <option
          v-for="(d, i) in devices()"
          :key="d.deviceId || i"
          :value="d.deviceId"
        >
          {{
            d.label ||
            `${source.kind === "audio" ? "Mikrofon" : "Kamera"} ${i + 1}`
          }}
        </option>
      </OptionSelect>
      <p
        v-else
        class="truncate py-1.5 text-sm font-medium"
        :title="source.label"
      >
        {{ source.label }}
      </p>
      <p class="px-1 text-xs text-muted-foreground tabular-nums">
        {{ detail() }}
      </p>
      <div
        v-if="source.kind === 'audio'"
        class="mx-1 h-1 overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        <div
          class="h-full rounded-full bg-foreground transition-[width] duration-150"
          :style="{ width: `${Math.min(100, level * 300)}%` }"
        />
      </div>
      <p
        v-if="status()"
        class="px-1 text-xs tabular-nums"
        :class="status()!.error ? 'text-destructive' : 'text-muted-foreground'"
      >
        {{ statusLabel(status()!.state) }} ·
        {{ duration(status()!.savedSeconds) }}
        <span v-if="status()!.error" class="block">{{ status()!.error }}</span>
      </p>
      <p v-if="status()?.warning" class="px-1 text-xs text-amber-500">
        {{ status()!.warning }}
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-0.5 pt-1">
      <Button
        v-if="source.kind === 'video'"
        variant="ghost"
        size="icon-xs"
        :class="live() ? 'bg-accent text-foreground' : 'text-muted-foreground'"
        :aria-pressed="live()"
        :title="live() ? 'Im Livebild' : 'Im Livebild zeigen'"
        :aria-label="`${source.label} im Livebild zeigen`"
        :disabled="locked || source.changing"
        @click="showLive"
        ><Radio aria-hidden="true"
      /></Button>
      <Button
        variant="ghost"
        size="icon-xs"
        class="text-muted-foreground"
        :disabled="locked || source.changing"
        :aria-label="`${source.label} entfernen`"
        title="Entfernen"
        @click="remove"
        ><X aria-hidden="true"
      /></Button>
    </div>
  </div>
</template>
