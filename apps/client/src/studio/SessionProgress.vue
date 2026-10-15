<script setup lang="ts">
import type { ParticipantProgress } from "../core/sessions.js";
import StatusBadge from "@/ui/patterns/StatusBadge.vue";
import { bytes, initial, participantLabel, participantTone } from "./state";

defineProps<{ participants: ParticipantProgress[] }>();
const percent = (p: ParticipantProgress) =>
  p.total ? Math.min(100, (p.bytes / p.total) * 100) : 0;
const amount = (p: ParticipantProgress) =>
  ["recording", "finalizing"].includes(p.state) || !p.total
    ? p.bytes
      ? bytes(p.bytes)
      : ""
    : p.bytes >= p.total
      ? bytes(p.total)
      : `${bytes(p.bytes)} / ${bytes(p.total)}`;
const moving = (p: ParticipantProgress) =>
  ["waiting", "sending", "receiving"].includes(p.state);
</script>

<template>
  <ul class="flex flex-col gap-1">
    <li
      v-for="p in participants"
      :key="p.id"
      class="flex items-start gap-3 rounded-md px-2 py-2"
    >
      <span
        class="relative grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium"
        >{{ initial(p.name)
        }}<span
          v-if="p.online !== undefined"
          class="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background"
          :class="p.online ? 'bg-emerald-500' : 'bg-muted-foreground/50'"
          :aria-label="p.online ? 'Verbunden' : 'Offline'"
      /></span>
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p class="min-w-0 truncate text-sm font-medium">
            {{ p.name }}
            <span class="font-normal text-muted-foreground"
              >· {{ p.self ? "Du" : p.role === "host" ? "Host" : "Gast" }}</span
            >
          </p>
          <span class="flex-1" />
          <span
            v-if="amount(p)"
            class="text-xs text-muted-foreground tabular-nums"
            >{{ amount(p) }}</span
          >
          <StatusBadge
            :label="participantLabel(p.state)"
            :tone="participantTone(p.state)"
          />
        </div>
        <div
          v-if="moving(p) && p.total"
          class="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          :aria-label="`Übertragung ${p.name}`"
          :aria-valuenow="Math.round(percent(p))"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            class="h-full rounded-full bg-foreground transition-[width] duration-500"
            :style="{ width: `${percent(p)}%` }"
          />
        </div>
        <p
          v-if="p.detail"
          class="text-xs"
          :class="
            p.state === 'waiting' && p.online !== false
              ? 'text-destructive'
              : 'text-muted-foreground'
          "
        >
          {{ p.detail }}
        </p>
      </div>
    </li>
  </ul>
</template>
