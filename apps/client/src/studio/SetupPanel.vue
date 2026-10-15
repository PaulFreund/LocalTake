<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { Check, FolderOpen, HardDrive, LogOut, Plus, Users } from "@lucide/vue";
import { profiles } from "../capture/manager.js";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { Switch } from "@/ui/components/switch";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
} from "@/ui/components/sidebar";
import OptionSelect from "@/ui/patterns/OptionSelect.vue";
import Disclosure from "@/ui/patterns/Disclosure.vue";
import type { Quality } from "../capture/manager.js";
import { BROWSER_STORAGE_ENABLED } from "../storage/selection.js";
import MissingSource from "./MissingSource.vue";
import SourceRow from "./SourceRow.vue";
import { act, bytes, studio } from "./state";

const props = defineProps<{ locked: boolean }>();
const dev = import.meta.env.DEV;
// Until a folder is granted no default devices are opened yet.
const has = (kind: "video" | "audio") =>
  !studio.value.store ||
  studio.value.capture.sources.some((s) => s.kind === kind);
const sourceKinds = ["video", "audio", "screen"] as const;
const sourceLocked = computed(
  () => props.locked || studio.value.sourcesChanging,
);
const sourcesOf = (kind: (typeof sourceKinds)[number]) =>
  studio.value.capture.sources.filter((source) => source.kind === kind);
const diagnostic = ref("");
const levels = ref<Record<string, number>>({});
const timer = setInterval(
  () => (levels.value = studio.value.capture.levels()),
  150,
);
onBeforeUnmount(() => clearInterval(timer));
const storageBusy = computed(
  () => props.locked || studio.value.probing || !!studio.value.busy,
);
const browserStatus = computed(() => studio.value.browserStorage);
const qualityLabels: Record<Quality, string> = {
  "720": "720p",
  "1080": "1080p",
  "2160": "4K",
};
const qualityText = (quality: Quality) =>
  `${qualityLabels[quality]} · ${profiles[quality].bitrate / 1e6} Mbit/s`;
const setQuality = (value: string) =>
  act(() => studio.value.setQuality(value as Quality));
const hostName = () =>
  studio.value.room.state?.peers.find((p) => p.role === "host")?.name ||
  "dem Host";
const setRecordScreen = (value: boolean) => {
  studio.value.recordScreen = value;
  studio.value.invalidate();
};
const openDiagnostic = (name: string) => {
  const folder = studio.value.testFolders.find((f) => f.name === name);
  if (folder) act(() => studio.value.useDiagnostic(folder));
  diagnostic.value = "";
};
const addSynthetic = () =>
  act(async () => {
    studio.value.invalidate();
    await studio.value.capture.synthetic();
  });
</script>

<template>
  <SidebarHeader class="h-12 justify-center border-b">
    <p class="px-2 text-sm font-semibold tracking-tight">LocalTake</p>
  </SidebarHeader>
  <SidebarContent class="gap-0">
    <SidebarGroup>
      <SidebarGroupLabel>Raum</SidebarGroupLabel>
      <SidebarGroupContent class="flex flex-col gap-2 px-2">
        <Input
          aria-label="Dein Name"
          placeholder="Dein Name"
          :model-value="studio.name"
          :disabled="studio.room.connected"
          :maxlength="60"
          @update:model-value="studio.setName(String($event))"
        />
        <Input
          v-if="!studio.invite && !studio.room.connected"
          aria-label="Raumname"
          placeholder="Raumname"
          :model-value="studio.roomName"
          :maxlength="60"
          @update:model-value="
            studio.roomName = String($event);
            studio.changed();
          "
        />
        <p v-if="studio.room.state?.name" class="px-1 text-sm font-medium">
          {{ studio.room.state.name }}
        </p>
        <template v-if="!studio.room.connected">
          <Button
            v-if="studio.invite"
            class="w-full"
            @click="act(() => studio.joinRoom())"
            ><Users aria-hidden="true" />Einladung annehmen</Button
          >
          <Button
            v-else
            variant="outline"
            class="w-full"
            @click="act(() => studio.createRoom())"
            ><Plus aria-hidden="true" />Raum erstellen</Button
          >
        </template>
        <Button
          v-if="studio.room.credentials"
          variant="ghost"
          size="sm"
          class="w-full text-muted-foreground"
          @click="act(() => studio.leave())"
          ><LogOut aria-hidden="true" />Raum verlassen</Button
        >
      </SidebarGroupContent>
    </SidebarGroup>

    <SidebarGroup>
      <SidebarGroupLabel>Quellen</SidebarGroupLabel>
      <SidebarGroupContent class="flex flex-col gap-2 px-2">
        <OptionSelect
          v-if="!studio.room.state || studio.isHost"
          aria-label="Aufnahmequalität"
          class="w-full"
          :model-value="studio.quality"
          :disabled="!studio.qualityEditable"
          @update:model-value="setQuality"
        >
          <option
            v-for="q in ['720', '1080', '2160'] as const"
            :key="q"
            :value="q"
          >
            {{ qualityText(q) }}{{ studio.room.state ? " · für alle" : "" }}
          </option>
        </OptionSelect>
        <p v-else class="px-1 text-xs text-muted-foreground">
          Aufnahmequalität {{ qualityText(studio.quality) }}, festgelegt von
          {{ hostName() }}.
        </p>
        <template v-for="kind in sourceKinds" :key="kind">
          <MissingSource
            v-if="kind !== 'screen' && !has(kind)"
            :kind="kind"
            :locked="sourceLocked"
          />
          <SourceRow
            v-for="source in sourcesOf(kind)"
            :key="source.slotId || source.id"
            :source="source"
            :level="levels[source.id] || 0"
            :locked="sourceLocked"
          />
        </template>
        <div v-if="has('video') || has('audio')" class="flex gap-2">
          <Button
            v-if="has('video')"
            variant="outline"
            size="sm"
            class="flex-1"
            :disabled="sourceLocked"
            @click="act(() => studio.addExtra('video'))"
            ><Plus aria-hidden="true" />Kamera</Button
          >
          <Button
            v-if="has('audio')"
            variant="outline"
            size="sm"
            class="flex-1"
            :disabled="sourceLocked"
            @click="act(() => studio.addExtra('audio'))"
            ><Plus aria-hidden="true" />Mikrofon</Button
          >
        </div>
        <Label class="justify-between py-1 font-normal">
          Bildschirm mit aufnehmen
          <Switch
            :model-value="studio.recordScreen"
            :disabled="locked"
            @update:model-value="setRecordScreen"
          />
        </Label>
      </SidebarGroupContent>
    </SidebarGroup>

    <SidebarGroup>
      <SidebarGroupLabel>Speicher</SidebarGroupLabel>
      <SidebarGroupContent class="flex flex-col gap-2 px-2">
        <Button
          variant="outline"
          class="w-full justify-start"
          :disabled="storageBusy || !studio.folderSupported"
          :title="
            studio.storageKind === 'folder' && studio.store
              ? 'Anderen Aufnahmeordner wählen'
              : undefined
          "
          @click="act(() => studio.folder())"
        >
          <FolderOpen aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate text-left">{{
            studio.storageKind === "folder" && studio.store
              ? studio.store.root.name
              : "Ordner wählen"
          }}</span>
          <Check
            v-if="studio.storageKind === 'folder' && studio.store"
            aria-label="Aktiv"
          />
        </Button>
        <template v-if="BROWSER_STORAGE_ENABLED">
          <Button
            variant="outline"
            class="w-full justify-start"
            :disabled="storageBusy || !studio.browserStorageSupported"
            @click="act(() => studio.useBrowserStorage())"
          >
            <HardDrive aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate text-left">Im Browser</span>
            <Check v-if="studio.storageKind === 'browser'" aria-label="Aktiv" />
          </Button>
          <div
            v-if="studio.storageKind === 'browser'"
            class="flex flex-col gap-1 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <p
              v-if="browserStatus?.quota != null && browserStatus.usage != null"
            >
              {{
                bytes(Math.max(0, browserStatus.quota - browserStatus.usage))
              }}
              frei · {{ bytes(browserStatus.usage) }} belegt
            </p>
            <p
              v-if="browserStatus?.persistent === false"
              class="text-destructive"
            >
              Kein Löschschutz – Aufnahmen nach dem Export herunterladen.
            </p>
            <p v-else-if="browserStatus?.persistent !== true">
              Löschschutz unbekannt
            </p>
            <Button
              v-if="browserStatus?.persistent !== true"
              variant="ghost"
              size="sm"
              :disabled="storageBusy"
              @click="act(() => studio.protectBrowserStorage())"
              >Löschschutz anfragen</Button
            >
          </div>
        </template>
        <p v-if="studio.testStorage" class="text-xs text-destructive">
          Diagnoseablage – nur für Tests
        </p>
        <p v-if="studio.store" class="text-xs text-muted-foreground">
          Prüfdateien: temp · ausstehende Originale: local · fertige Spuren:
          Raum/Aufnahme. LocalTake entfernt lokale Originale nach 7 Tagen,
          solange die Seite geöffnet und der Ordner freigegeben ist.
        </p>
      </SidebarGroupContent>
    </SidebarGroup>

    <SidebarGroup>
      <SidebarGroupLabel>Aufnahme</SidebarGroupLabel>
      <SidebarGroupContent class="flex flex-col gap-2 px-2">
        <p
          class="text-xs"
          :class="
            studio.readinessError ? 'text-destructive' : 'text-muted-foreground'
          "
          role="status"
        >
          {{ studio.readinessReason }}
        </p>
        <Label class="justify-between py-1 font-normal">
          Aufnahme freigeben
          <Switch
            :model-value="studio.armed"
            :disabled="!studio.probePassed || locked"
            @update:model-value="act(() => studio.arm($event))"
          />
        </Label>
        <p v-if="studio.room.state" class="text-xs text-muted-foreground">
          {{
            studio.isDestination
              ? "Nach jeder Aufnahme senden die Gäste ihre Originale automatisch an diesen PC."
              : `Deine Originale werden nach jeder Aufnahme automatisch an ${hostName()} gesendet.`
          }}
        </p>
      </SidebarGroupContent>
    </SidebarGroup>
  </SidebarContent>
  <SidebarFooter v-if="dev" class="border-t">
    <Disclosure title="Diagnose" class="px-2 py-1">
      <div class="flex flex-col gap-1">
        <Button
          variant="ghost"
          size="sm"
          class="justify-start"
          :disabled="locked"
          @click="addSynthetic"
          >2 Testkameras + 2 Testmikrofone</Button
        >
        <Button
          variant="ghost"
          size="sm"
          class="justify-start"
          :disabled="locked"
          @click="act(() => studio.diagnosticStorage())"
          >Temporäre Testablage</Button
        >
        <OptionSelect
          v-if="studio.testFolders.length"
          v-model="diagnostic"
          aria-label="Vorige Testablage"
          placeholder="Vorige Testablage …"
          :disabled="locked"
          @update:model-value="openDiagnostic"
        >
          <option v-for="f in studio.testFolders" :key="f.name" :value="f.name">
            {{ f.name }}
          </option>
        </OptionSelect>
      </div>
    </Disclosure>
  </SidebarFooter>
</template>
