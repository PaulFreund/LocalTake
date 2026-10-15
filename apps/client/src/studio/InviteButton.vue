<script setup lang="ts">
import { Check, Copy, UserPlus } from "@lucide/vue";
import { ref } from "vue";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/components/popover";
import { act, studio } from "./state";

const copied = ref(false);
const copy = () =>
  act(async () => {
    await studio.value.copyInvite();
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  });
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button variant="outline" size="sm"
        ><UserPlus aria-hidden="true" /><span class="max-sm:sr-only"
          >Einladen</span
        ></Button
      >
    </PopoverTrigger>
    <PopoverContent align="end" class="flex w-80 gap-2">
      <Input
        aria-label="Einladungslink"
        readonly
        :model-value="studio.invitation()"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <Button
        variant="outline"
        size="icon"
        :aria-label="copied ? 'Kopiert' : 'Kopieren'"
        @click="copy"
      >
        <Check v-if="copied" aria-hidden="true" />
        <Copy v-else aria-hidden="true" />
      </Button>
    </PopoverContent>
  </Popover>
</template>
