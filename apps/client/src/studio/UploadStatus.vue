<script setup lang="ts">
import { CloudUpload, Check } from "@lucide/vue";
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "reka-ui";
import { Button } from "@/ui/components/button";
import SessionProgress from "./SessionProgress.vue";
import { act, bytes, studio } from "./state";

// Functions, not computeds: they read the runtime on every render, see state.ts.
const session = () => studio.value.currentSession;
// A guest sends everything still pending in this room; the host shows how much
// of the current session has arrived.
const progress = () => {
  const s = studio.value;
  if (!s.isDestination) return s.sync.status;
  const current = session();
  return { bytes: current?.bytes ?? 0, total: current?.total ?? 0 };
};
const percent = () => {
  const { bytes, total } = progress();
  return total ? Math.min(100, (bytes / total) * 100) : 0;
};
const title = () =>
  studio.value.archiveError
    ? "Sitzungsordner noch nicht fertig"
    : studio.value.uploadPending
      ? studio.value.isDestination
        ? "Originale der Gäste werden gesammelt"
        : `Originale werden an ${studio.value.archiveDestination?.name || "den Host"} gesendet`
      : "Alle Originale sind gesichert";
const visible = () => {
  const s = studio.value;
  if (s.uploadPending) return true;
  if (!s.room.state) return false;
  const current = session();
  return s.isDestination
    ? current?.role === "master" &&
        current.settled &&
        current.participants.length > 1
    : s.sync.status.state === "done";
};
const close = () => {
  studio.value.syncDialog = false;
  studio.value.leaveRequested = false;
  studio.value.changed();
};
const updateOpen = (value: boolean) => {
  if (!value) close();
};
</script>

<template>
  <div
    v-if="visible()"
    class="flex shrink-0 flex-col gap-1.5 border-b bg-muted/50 px-4 py-2 text-sm"
    role="status"
  >
    <div class="flex flex-wrap items-center gap-3">
      <CloudUpload
        v-if="studio.uploadPending"
        class="size-4 shrink-0"
        aria-hidden="true"
      />
      <Check
        v-else
        class="size-4 shrink-0 text-emerald-500"
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1">
        {{ title()
        }}{{
          studio.uploadPending
            ? " – diese Seite bis zum Abschluss geöffnet lassen."
            : "."
        }}
        <span
          v-if="
            !studio.isDestination &&
            studio.sync.status.pending &&
            studio.sync.status.reason
          "
          class="block text-xs text-muted-foreground"
          >{{ studio.sync.status.reason }}</span
        >
      </span>
      <span
        v-if="progress().total"
        class="text-xs text-muted-foreground tabular-nums"
        >{{ bytes(progress().bytes) }} / {{ bytes(progress().total) }}</span
      >
      <Button
        variant="outline"
        size="sm"
        @click="
          studio.syncDialog = true;
          studio.changed();
        "
        >Details</Button
      >
    </div>
    <div
      v-if="studio.uploadPending && progress().total"
      class="h-1.5 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label="Übertragungsfortschritt"
      :aria-valuenow="Math.round(percent())"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div
        class="h-full rounded-full bg-foreground transition-[width] duration-500"
        :style="{ width: `${percent()}%` }"
      />
    </div>
  </div>
  <DialogRoot :open="studio.syncDialog" @update:open="updateOpen">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/60" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 flex max-h-[90svh] w-[min(92vw,34rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-6 shadow-xl"
      >
        <DialogTitle class="text-lg font-semibold">{{ title() }}</DialogTitle>
        <DialogDescription class="text-sm text-muted-foreground">
          <template v-if="studio.uploadPending">
            Bitte den Tab und den Browser noch nicht schließen.
            {{
              studio.isDestination
                ? "Die Gäste senden ihre Originale an diesen PC; sie werden im Sitzungsordner fertiggestellt."
                : `Die Dateien werden an ${studio.archiveDestination?.name || "den Host"} übertragen.`
            }}
            Bei einer Unterbrechung bleiben die lokalen Originale erhalten.
            Öffne später denselben Raumlink; die Übertragung setzt dann
            automatisch fort.
          </template>
          <template v-else
            >Die Übertragung und Speicherung sind abgeschlossen. Du kannst diese
            Seite jetzt schließen.</template
          >
        </DialogDescription>
        <SessionProgress
          v-if="session() && session()!.role !== 'solo'"
          :participants="session()!.participants"
        />
        <p
          v-if="!studio.isDestination && studio.sync.status.pending > 1"
          class="text-sm text-muted-foreground tabular-nums"
        >
          {{ studio.sync.status.pending }} Aufnahmen dieses Raums warten noch
          auf die Übertragung.
        </p>
        <p
          v-if="
            !studio.isDestination &&
            studio.sync.status.reason &&
            studio.sync.status.pending
          "
          class="text-sm"
        >
          {{ studio.sync.status.reason }}
        </p>
        <p v-if="studio.archiveFinalizing" class="text-sm">
          Sitzungsordner und Metadaten werden fertiggestellt …
        </p>
        <p v-if="studio.archiveError" class="text-sm text-destructive">
          {{ studio.archiveError }}
        </p>
        <Button
          v-if="studio.archiveError"
          variant="outline"
          @click="studio.retryArchive()"
          >Sitzungsordner erneut fertigstellen</Button
        >
        <div class="flex flex-wrap justify-end gap-2">
          <Button
            v-if="studio.leaveRequested && studio.uploadPending"
            variant="outline"
            @click="act(() => studio.leave(true))"
            >Unterbrechen und Raum verlassen</Button
          >
          <Button @click="close">{{
            studio.uploadPending
              ? "Offen lassen und weiter übertragen"
              : "Fertig"
          }}</Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
