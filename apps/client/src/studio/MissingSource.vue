<script setup lang="ts">
import { ref } from "vue";
import { Camera, Mic } from "@lucide/vue";
import { Button } from "@/ui/components/button";
import OptionSelect from "@/ui/patterns/OptionSelect.vue";
import { act, studio } from "./state";

// The default camera or microphone that is not open; shows why and lets the
// user pick a device and try again.
const props = defineProps<{ kind: "video" | "audio"; locked: boolean }>();
const device = ref("");
const devices = () =>
  studio.value.devices.filter(
    (d) =>
      d.kind === (props.kind === "audio" ? "audioinput" : "videoinput") &&
      d.deviceId,
  );
const noun = () => (props.kind === "audio" ? "Mikrofon" : "Kamera");
</script>

<template>
  <div
    class="flex items-start gap-2 rounded-md border border-dashed p-2"
    :class="{ 'border-destructive/50': studio.sourceErrors[kind] }"
  >
    <component
      :is="kind === 'audio' ? Mic : Camera"
      class="mt-2 size-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <div class="flex gap-1.5">
        <OptionSelect
          v-model="device"
          class="h-8 min-w-0 flex-1"
          :aria-label="noun()"
          :disabled="locked"
        >
          <option value="">
            Standard{{ kind === "audio" ? "mikrofon" : "kamera" }}
          </option>
          <option
            v-for="(d, i) in devices()"
            :key="d.deviceId"
            :value="d.deviceId"
          >
            {{ d.label || `${noun()} ${i + 1}` }}
          </option>
        </OptionSelect>
        <Button
          variant="outline"
          size="sm"
          class="h-8"
          :disabled="locked"
          @click="act(() => studio.add(kind, device))"
          >Öffnen</Button
        >
      </div>
      <p
        class="px-1 text-xs"
        :class="
          studio.sourceErrors[kind]
            ? 'text-destructive'
            : 'text-muted-foreground'
        "
        role="status"
      >
        {{
          studio.sourceErrors[kind]
            ? `${noun()} nicht geöffnet: ${studio.sourceErrors[kind]}`
            : studio.openingDefaults
              ? `${noun()} wird geöffnet …`
              : `Kein${kind === "audio" ? "" : "e"} ${noun()} geöffnet.`
        }}
      </p>
    </div>
  </div>
</template>
