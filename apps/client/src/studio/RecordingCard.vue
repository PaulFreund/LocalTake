<script setup lang="ts">
import { computed } from "vue";
import { ArrowDownToLine, Camera, Mic } from "@lucide/vue";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/ui/components/card";
import Disclosure from "@/ui/patterns/Disclosure.vue";
import StatusBadge from "@/ui/patterns/StatusBadge.vue";
import type { StoredInventory } from "../storage/store.js";
import { act, bytes, studio } from "./state";

const props = defineProps<{ inventory: StoredInventory }>();
const dev = import.meta.env.DEV;
const size = computed(() =>
  props.inventory.segments.reduce((n, s) => n + s.byteLength, 0),
);
const idle = computed(() => !studio.value.busy && !studio.value.recording);
const segments = () =>
  JSON.stringify(
    props.inventory.segments.map((s) => ({
      trackId: s.trackId,
      sequence: s.sequence,
      start: s.mediaStartUs,
      duration: s.mediaDurationUs,
      sampleStart: s.sampleStart,
      sampleCount: s.sampleCount,
    })),
    null,
    2,
  );
</script>

<template>
  <Card class="gap-4 py-4">
    <CardHeader class="px-4">
      <CardTitle class="truncate">{{
        inventory.recording.participantName
      }}</CardTitle>
      <CardDescription class="tabular-nums">
        {{ new Date(inventory.recording.createdAt).toLocaleString("de-DE") }} ·
        {{ bytes(size) }}
      </CardDescription>
      <CardAction>
        <StatusBadge
          :label="inventory.complete ? 'Verifiziert' : 'Teilbestand'"
          :tone="inventory.complete ? 'good' : 'warning'"
        />
      </CardAction>
    </CardHeader>
    <CardContent class="flex flex-col gap-3 px-4">
      <div class="flex flex-wrap gap-1.5">
        <Badge
          v-for="t in inventory.tracks"
          :key="t.epochId"
          variant="secondary"
          class="max-w-full font-normal"
        >
          <Mic v-if="t.kind === 'audio'" aria-hidden="true" />
          <Camera v-else aria-hidden="true" />
          <span class="truncate">{{ t.label }}</span>
        </Badge>
      </div>
      <Disclosure
        v-if="inventory.issues.length"
        :title="`${inventory.issues.length} Hinweise`"
      >
        <ul class="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li v-for="(issue, i) in inventory.issues" :key="i">{{ issue }}</li>
        </ul>
      </Disclosure>
      <Disclosure
        v-if="inventory.warnings?.length"
        :title="`${inventory.warnings.length} Aufnahmehinweise`"
      >
        <ul class="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li v-for="(warning, i) in inventory.warnings" :key="i">
            {{ warning }}
          </li>
        </ul>
      </Disclosure>
      <Disclosure v-if="dev" title="Segmentdiagnose">
        <pre class="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">{{
          segments()
        }}</pre>
      </Disclosure>
    </CardContent>
    <CardFooter class="flex-wrap gap-2 px-4">
      <Button
        v-if="!inventory.transferredTo"
        variant="outline"
        size="sm"
        :disabled="!idle"
        @click="act(() => studio.export(inventory))"
        ><ArrowDownToLine aria-hidden="true" />Exportieren</Button
      >
    </CardFooter>
  </Card>
</template>
