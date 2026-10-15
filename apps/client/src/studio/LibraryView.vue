<script setup lang="ts">
import { ref } from "vue";
import {
  ArrowDownToLine,
  FolderOpen,
  LoaderCircle,
  ShieldCheck,
} from "@lucide/vue";
import { Button } from "@/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/ui/components/empty";
import Disclosure from "@/ui/patterns/Disclosure.vue";
import StatusBadge from "@/ui/patterns/StatusBadge.vue";
import SessionPanel from "./SessionPanel.vue";
import { act, bytes, sessionTitle, studio } from "./state";

defineProps<{ locked: boolean }>();
const view = ref<"current" | "older">("current");
// Functions, not computeds: they read the runtime on every render, see state.ts.
const older = () =>
  studio.value.sessions.filter((s) => s.id !== studio.value.currentSessionId);
const names = (session: (typeof studio.value.sessions)[number]) =>
  session.participants.map((p) => p.name).join(", ");
const tabClass =
  "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-selected:bg-muted aria-selected:text-foreground";
</script>

<template>
  <div class="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
    <div class="flex flex-wrap items-center gap-3">
      <div role="tablist" aria-label="Sitzungen" class="flex gap-1">
        <button
          role="tab"
          :aria-selected="view === 'current'"
          :class="tabClass"
          @click="view = 'current'"
        >
          Aktuelle Sitzung
        </button>
        <button
          role="tab"
          :aria-selected="view === 'older'"
          :class="tabClass"
          @click="view = 'older'"
        >
          Frühere Sitzungen
          <span
            v-if="older().length"
            class="ml-1 rounded-full bg-background px-1.5 text-xs tabular-nums"
            >{{ older().length }}</span
          >
        </button>
      </div>
      <span class="flex-1" />
      <span
        v-if="studio.busy"
        class="flex items-center gap-2 text-sm text-muted-foreground"
        role="status"
        ><LoaderCircle class="size-4 animate-spin" aria-hidden="true" />{{
          studio.busy
        }}</span
      >
      <Button
        variant="outline"
        size="sm"
        title="Alle Originale erneut auf Vollständigkeit und Prüfsummen prüfen"
        :disabled="!studio.store || locked || !!studio.busy"
        @click="act(() => studio.scan())"
        ><ShieldCheck aria-hidden="true" />Prüfen</Button
      >
    </div>

    <section
      v-if="studio.exported.length"
      class="flex flex-col gap-3 rounded-xl border p-4"
    >
      <h2 class="text-sm font-medium">Export</h2>
      <div
        v-for="file in studio.exported"
        :key="file.url"
        class="flex flex-col gap-2"
      >
        <a
          :href="file.url"
          :download="file.name"
          class="flex items-center gap-2 text-sm hover:underline"
          ><ArrowDownToLine
            class="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          /><span class="min-w-0 truncate">{{ file.name }}</span
          ><span class="text-xs text-muted-foreground tabular-nums">{{
            bytes(file.size)
          }}</span></a
        >
        <video
          v-if="file.name.endsWith('.mp4')"
          :aria-label="file.name"
          controls
          preload="metadata"
          :src="file.url"
          class="max-h-56 w-full rounded-md bg-neutral-950 dark:bg-neutral-900"
        />
        <audio
          v-if="file.name.endsWith('.wav')"
          :aria-label="file.name"
          controls
          preload="metadata"
          :src="file.url"
          class="w-full"
        />
      </div>
    </section>

    <template v-if="view === 'current'">
      <template v-if="studio.currentSession">
        <h1 class="text-lg font-semibold tracking-tight">
          Sitzung vom {{ sessionTitle(studio.currentSession.startedAt) }}
        </h1>
        <SessionPanel :session="studio.currentSession" :locked="locked" />
      </template>
      <Empty v-else class="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon"
            ><FolderOpen aria-hidden="true"
          /></EmptyMedia>
          <EmptyTitle>Noch keine Aufnahme in dieser Sitzung</EmptyTitle>
          <EmptyDescription>
            Eine Sitzung reicht von „Aufnehmen“ bis „Stoppen“.
            <template v-if="older().length">
              Ältere Aufnahmen stehen unter „Frühere Sitzungen“.</template
            >
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </template>

    <template v-else>
      <Disclosure v-for="session in older()" :key="session.id" variant="card">
        <template #trigger>
          <span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3">
            <span class="font-medium">{{
              sessionTitle(session.startedAt)
            }}</span>
            <span
              class="min-w-0 truncate text-xs font-normal text-muted-foreground"
              >{{ names(session) }}</span
            >
            <span class="flex-1" />
            <StatusBadge
              v-if="!session.settled"
              label="Übertragung offen"
              tone="warning"
            />
          </span>
        </template>
        <SessionPanel :session="session" :locked="locked" />
      </Disclosure>
      <Empty v-if="!older().length" class="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon"
            ><FolderOpen aria-hidden="true"
          /></EmptyMedia>
          <EmptyTitle>{{
            studio.store ? "Keine früheren Sitzungen" : "Kein Speicher gewählt"
          }}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    </template>
  </div>
</template>
