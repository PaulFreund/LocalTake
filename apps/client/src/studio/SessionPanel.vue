<script setup lang="ts">
import { ArrowDownToLine } from "@lucide/vue";
import { Button } from "@/ui/components/button";
import StatusBadge from "@/ui/patterns/StatusBadge.vue";
import type { SessionView } from "../core/sessions.js";
import RecordingCard from "./RecordingCard.vue";
import SessionProgress from "./SessionProgress.vue";
import { act, bytes, studio } from "./state";

defineProps<{ session: SessionView; locked: boolean }>();
const summary = (session: SessionView) => {
  const states = session.participants.map((p) => p.state);
  if (states.some((s) => s === "recording" || s === "finalizing"))
    return { label: "Aufnahme läuft", tone: "neutral" as const };
  if (!session.settled)
    return {
      label:
        session.role === "slave"
          ? "Wird an den Host gesendet"
          : "Originale werden gesammelt",
      tone: "warning" as const,
    };
  if (states.some((s) => s === "failed" || s === "partial"))
    return { label: "Unvollständig", tone: "warning" as const };
  return {
    label: session.role === "slave" ? "Beim Host gesichert" : "Vollständig",
    tone: "good" as const,
  };
};
</script>

<template>
  <section class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-3">
      <StatusBadge
        :label="summary(session).label"
        :tone="summary(session).tone"
      />
      <span
        v-if="session.total && !session.settled"
        class="text-xs text-muted-foreground tabular-nums"
        >{{ bytes(session.bytes) }} / {{ bytes(session.total) }}</span
      >
      <span class="flex-1" />
      <Button
        v-if="session.recordings.some((i) => !('transferredTo' in i))"
        variant="outline"
        size="sm"
        :disabled="locked || studio.probing || !!studio.busy"
        @click="act(() => studio.exportAll({ recordingId: session.id }))"
        ><ArrowDownToLine aria-hidden="true" />Sitzung exportieren</Button
      >
    </div>
    <div
      v-if="session.role !== 'solo'"
      class="rounded-xl border p-2"
      :aria-label="
        session.role === 'master' ? 'Teilnehmer und Übertragung' : 'Upload'
      "
    >
      <SessionProgress :participants="session.participants" />
    </div>
    <div v-if="session.recordings.length" class="grid gap-4 lg:grid-cols-2">
      <RecordingCard
        v-for="inv in session.recordings"
        :key="`${inv.recording.recordingId}/${inv.recording.participantId}`"
        :inventory="inv"
      />
    </div>
  </section>
</template>
