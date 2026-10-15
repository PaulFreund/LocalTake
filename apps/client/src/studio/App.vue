<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { Users, X } from "@lucide/vue";
import { Button } from "@/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/ui/components/sheet";
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/ui/components/sidebar";
import StatusBadge from "@/ui/patterns/StatusBadge.vue";
import InviteButton from "./InviteButton.vue";
import DiagnosticsPanel from "./DiagnosticsPanel.vue";
import LibraryView from "./LibraryView.vue";
import RoomPanel from "./RoomPanel.vue";
import SetupPanel from "./SetupPanel.vue";
import StorageGate from "./StorageGate.vue";
import StudioView from "./StudioView.vue";
import ThemeMenu from "./ThemeMenu.vue";
import UploadStatus from "./UploadStatus.vue";
import { studio } from "./state";

const tab = ref<"studio" | "library">("studio");
const sidebarKey = "localtake-sidebar-collapsed";
const sidebarOpen = ref(true);
try {
  sidebarOpen.value = localStorage.getItem(sidebarKey) !== "true";
} catch {
  /* Optional view state. */
}
watch(sidebarOpen, (open) => {
  try {
    if (open) localStorage.removeItem(sidebarKey);
    else localStorage.setItem(sidebarKey, "true");
  } catch {
    /* Optional view state. */
  }
});
const mobile = useMediaQuery("(max-width: 768px)");
const wide = useMediaQuery("(min-width: 1280px)");
const roomOpen = ref(false);
watch(wide, (value) => value && (roomOpen.value = false));
const inRoom = computed(() => !!studio.value.room.credentials);
// Chat arriving while the room panel is out of view marks the panel button.
const seen = ref(0);
watch(
  [() => studio.value.chat.length, wide, roomOpen],
  ([count, visible, open]) => {
    if (visible || open) seen.value = count;
  },
  { immediate: true },
);
const unread = computed(() => studio.value.chat.length > seen.value);
const locked = computed(() => {
  const s = studio.value;
  return Boolean(
    s.recording || s.pendingStart || s.groupActive || s.storageChoosing,
  );
});
// The archive is rescanned after every recording and received upload.
const openLibrary = () => (tab.value = "library");
const sessionCount = () => studio.value.currentSession?.participants.length;
const dismissNotice = () => {
  studio.value.notice = "";
  studio.value.changed();
};
const tabClass =
  "-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-selected:border-foreground aria-selected:text-foreground";
</script>

<template>
  <SidebarProvider
    v-model:open="sidebarOpen"
    :style="{ '--sidebar-width': '20rem' }"
  >
    <Sidebar id="setup" aria-label="Einrichtung">
      <SetupPanel :locked="locked" />
    </Sidebar>
    <SidebarInset class="h-svh min-w-0 overflow-hidden">
      <header
        class="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 md:px-4"
      >
        <SidebarTrigger class="size-8" aria-controls="setup" />
        <span
          v-if="!sidebarOpen || mobile"
          class="text-sm font-semibold tracking-tight max-sm:hidden"
          >LocalTake</span
        >
        <nav role="tablist" class="flex h-full items-stretch">
          <button
            role="tab"
            :aria-selected="tab === 'studio'"
            :class="tabClass"
            @click="tab = 'studio'"
          >
            Studio
          </button>
          <button
            role="tab"
            :aria-selected="tab === 'library'"
            :class="tabClass"
            @click="openLibrary"
          >
            Aufnahmen
            <span
              v-if="sessionCount()"
              class="rounded-full bg-muted px-1.5 text-xs tabular-nums"
              :title="`${sessionCount()} Teilnehmer in der aktuellen Sitzung`"
              >{{ sessionCount() }}</span
            >
          </button>
        </nav>
        <div class="flex-1" />
        <StatusBadge
          v-if="inRoom && !studio.room.connected"
          label="Getrennt"
          tone="bad"
        />
        <InviteButton v-if="studio.isHost" />
        <Button
          v-if="inRoom && !wide"
          variant="ghost"
          size="icon-sm"
          class="relative"
          aria-label="Teilnehmer und Chat"
          @click="roomOpen = true"
        >
          <Users aria-hidden="true" />
          <span
            v-if="unread"
            class="absolute top-1.5 right-1.5 size-2 rounded-full bg-foreground"
            aria-label="Neue Nachrichten"
          />
        </Button>
        <ThemeMenu />
        <DiagnosticsPanel />
      </header>
      <UploadStatus />
      <div
        v-if="studio.error"
        role="alert"
        class="flex shrink-0 items-start gap-3 border-b bg-destructive/5 px-4 py-2 text-sm text-destructive"
      >
        <p class="min-w-0 flex-1 whitespace-pre-line [overflow-wrap:anywhere]">
          {{ studio.error }}
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Fehlermeldung schließen"
          @click="studio.clearError()"
          ><X aria-hidden="true"
        /></Button>
      </div>
      <div
        v-if="studio.notice"
        role="status"
        class="flex shrink-0 items-start gap-3 border-b bg-muted/50 px-4 py-2 text-sm text-muted-foreground"
      >
        <p class="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {{ studio.notice }}
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Hinweis schließen"
          @click="dismissNotice"
          ><X aria-hidden="true"
        /></Button>
      </div>
      <div class="flex min-h-0 flex-1">
        <div class="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <!-- Stays mounted: remote audio plays through the studio's video elements. -->
          <StudioView v-show="tab === 'studio'" />
          <LibraryView v-if="tab === 'library'" :locked="locked" />
        </div>
        <aside
          v-if="inRoom && wide"
          class="w-72 shrink-0 border-l"
          aria-label="Teilnehmer und Chat"
        >
          <RoomPanel />
        </aside>
      </div>
    </SidebarInset>
    <Sheet v-model:open="roomOpen">
      <SheetContent side="right" class="w-80 gap-0 p-0">
        <SheetHeader class="sr-only">
          <SheetTitle>Raum</SheetTitle>
          <SheetDescription>Teilnehmer und Chat</SheetDescription>
        </SheetHeader>
        <RoomPanel />
      </SheetContent>
    </Sheet>
    <StorageGate />
  </SidebarProvider>
</template>
