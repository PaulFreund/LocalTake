<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { SendHorizontal } from "@lucide/vue";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { initial, statusLabel, studio } from "./state";

const draft = ref("");
const messages = ref<HTMLElement>();
const peers = computed(() => studio.value.room.state?.peers || []);
const self = computed(() => studio.value.room.credentials?.participantId);
const state = (peer: (typeof peers.value)[number]) =>
  !peer.connected
    ? "Offline"
    : peer.recording &&
        ["recording", "finalizing"].includes(peer.recording.state)
      ? statusLabel(peer.recording.state)
      : peer.ready
        ? "Freigegeben"
        : peer.readyReason || "Richtet ein";
const send = () => {
  const text = draft.value.trim();
  if (!text) return;
  studio.value.room.send({ type: "chat", text });
  draft.value = "";
};
watch(
  () => studio.value.chat.length,
  async () => {
    await nextTick();
    messages.value?.scrollTo({ top: messages.value.scrollHeight });
  },
);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <h2 class="px-4 pt-4 pb-2 text-xs font-medium text-muted-foreground">
      Teilnehmer <span class="tabular-nums">· {{ peers.length }}/4</span>
    </h2>
    <ul class="flex flex-col gap-1 px-2">
      <li
        v-for="peer in peers"
        :key="peer.id"
        class="flex items-center gap-3 rounded-md px-2 py-1.5"
      >
        <span
          class="relative grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium"
          >{{ initial(peer.name)
          }}<span
            class="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background"
            :class="
              peer.connected ? 'bg-emerald-500' : 'bg-muted-foreground/50'
            "
            aria-hidden="true"
        /></span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">
            {{ peer.name
            }}<span v-if="peer.id === self" class="text-muted-foreground">
              · Du</span
            >
          </p>
          <p class="truncate text-xs text-muted-foreground">
            {{ peer.role === "host" ? "Host" : "Gast" }} · {{ state(peer) }}
          </p>
          <p
            v-if="peer.recording?.sources.some((s) => s.error)"
            class="text-xs text-destructive"
          >
            Spurfehler
          </p>
          <p v-if="peer.upload?.pending" class="text-xs text-amber-500">
            {{
              peer.upload.state === "uploading"
                ? "Lädt Originale hoch"
                : peer.upload.reason || "Upload ausstehend"
            }}
          </p>
          <p
            v-else-if="peer.upload?.state === 'done'"
            class="text-xs text-emerald-500"
          >
            Originale übertragen
          </p>
        </div>
      </li>
    </ul>
    <p
      v-if="studio.room.state?.take?.phase === 'stopping'"
      class="mx-4 mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
      role="status"
    >
      Warte auf Abschlussmeldungen. Offline-Teilnehmer stoppen selbst.
    </p>

    <div class="mt-4 flex min-h-0 flex-1 flex-col border-t">
      <h2 class="px-4 pt-4 pb-2 text-xs font-medium text-muted-foreground">
        Chat
      </h2>
      <div
        ref="messages"
        class="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-4"
        aria-live="polite"
      >
        <div v-for="m in studio.chat" :key="m.id" class="text-sm">
          <p class="text-xs font-medium text-muted-foreground">{{ m.name }}</p>
          <p class="[overflow-wrap:anywhere]">{{ m.text }}</p>
        </div>
      </div>
      <form class="flex gap-2 p-3" @submit.prevent="send">
        <Input
          v-model="draft"
          aria-label="Nachricht"
          placeholder="Nachricht"
          :maxlength="2000"
          :disabled="!studio.room.connected"
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          aria-label="Senden"
          :disabled="!studio.room.connected || !draft.trim()"
          ><SendHorizontal aria-hidden="true"
        /></Button>
      </form>
    </div>
  </div>
</template>
