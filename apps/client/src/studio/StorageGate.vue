<script setup lang="ts">
import { ref } from "vue";
import { FolderOpen, LoaderCircle } from "@lucide/vue";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { BROWSER_STORAGE_ENABLED } from "../storage/selection.js";
import { act, studio } from "./state";
import DiagnosticsPanel from "./DiagnosticsPanel.vue";

const dev = import.meta.env.DEV;
const joining = ref(false);
const invitePending = () =>
  !studio.value.room.credentials && !!studio.value.invite;
const join = () =>
  act(async () => {
    joining.value = true;
    try {
      await studio.value.joinRoom();
    } finally {
      joining.value = false;
    }
  });
// Recording and receiving need a writable folder, so this dialog cannot be
// dismissed; it closes once a folder is chosen and its write test passed.
const open = () =>
  invitePending() ||
  studio.value.storageRestoring ||
  !studio.value.store ||
  !!studio.value.directoryToReconnect;
const busy = () =>
  joining.value ||
  studio.value.storageChoosing ||
  !!studio.value.busy ||
  (!invitePending() && studio.value.storageRestoring);
</script>

<template>
  <DialogRoot :open="open()">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/60" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 flex w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-background p-6 shadow-xl"
        @escape-key-down.prevent
        @pointer-down-outside.prevent
        @interact-outside.prevent
      >
        <div class="flex items-center justify-between gap-3">
          <DialogTitle class="text-lg font-semibold">{{
            invitePending()
              ? "Einladung annehmen"
              : studio.storageRestoring
                ? "Aufnahmeordner prüfen"
                : studio.directoryToReconnect
                  ? "Aufnahmeordner freigeben"
                  : "Aufnahmeordner wählen"
          }}</DialogTitle>
          <DiagnosticsPanel />
        </div>
        <DialogDescription
          class="flex flex-col gap-2 text-sm text-muted-foreground"
        >
          <template v-if="invitePending()">
            <span
              >Du bist noch nicht im Raum. Gib deinen Namen ein und nimm die
              Einladung an. Danach gibst du deinen lokalen Aufnahmeordner
              frei.</span
            >
          </template>
          <template v-else-if="studio.directoryToReconnect">
            <span
              >Der Browser braucht erneut deine Erlaubnis, in „{{
                studio.directoryToReconnect.name
              }}“ zu schreiben. Bis dahin sind Aufnahme und Empfang
              gesperrt.</span
            >
          </template>
          <template v-else>
            <span
              >LocalTake speichert jede Kamera und jedes Mikrofon als Original
              direkt in einen Ordner auf diesem Rechner. Wähle einen Ordner und
              erlaube den Schreibzugriff.</span
            >
          </template>
          <span v-if="!invitePending()"
            >Am besten ein lokales Laufwerk mit genug freiem Platz und keinen
            Ordner, den OneDrive, Dropbox oder ein ähnlicher Dienst
            synchronisiert.</span
          >
        </DialogDescription>
        <p
          v-if="!invitePending() && !studio.folderSupported"
          class="text-sm text-destructive"
          role="alert"
        >
          Dieser Browser bietet keine Ordnerfreigabe an. Bitte Desktop-Chrome
          oder Edge verwenden.
        </p>
        <p
          v-if="studio.error"
          class="text-sm [overflow-wrap:anywhere] text-destructive"
          role="alert"
        >
          {{ studio.error }}
        </p>
        <p
          v-if="!invitePending() && busy()"
          class="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />{{
            studio.notice || "Gespeicherten Aufnahmeordner laden …"
          }}
        </p>
        <form
          v-if="invitePending()"
          class="flex flex-col gap-3"
          @submit.prevent="join"
        >
          <Label for="invite-name">Dein Name</Label>
          <Input
            id="invite-name"
            autocomplete="nickname"
            :maxlength="60"
            :model-value="studio.name"
            :disabled="busy()"
            @update:model-value="studio.setName(String($event))"
          />
          <Button type="submit" :disabled="busy() || !studio.name.trim()">
            <LoaderCircle
              v-if="joining"
              class="size-4 animate-spin"
              aria-hidden="true"
            />
            {{ joining ? "Beitritt läuft …" : "Einladung annehmen" }}
          </Button>
        </form>
        <div v-else class="flex flex-wrap justify-end gap-2">
          <Button
            v-if="dev"
            variant="ghost"
            :disabled="busy()"
            @click="act(() => studio.diagnosticStorage())"
            >Temporäre Testablage</Button
          >
          <Button
            v-if="BROWSER_STORAGE_ENABLED && studio.browserStorageSupported"
            variant="outline"
            :disabled="busy()"
            @click="act(() => studio.useBrowserStorage())"
            >Im Browser speichern</Button
          >
          <template v-if="studio.directoryToReconnect">
            <Button
              variant="outline"
              :disabled="busy() || !studio.folderSupported"
              @click="act(() => studio.folder())"
              >Anderen Ordner wählen</Button
            >
            <Button
              :disabled="busy()"
              @click="act(() => studio.reconnectFolder())"
              ><FolderOpen aria-hidden="true" />Freigeben</Button
            >
          </template>
          <Button
            v-else
            :disabled="busy() || !studio.folderSupported"
            @click="act(() => studio.folder())"
            ><FolderOpen aria-hidden="true" />Ordner wählen</Button
          >
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
