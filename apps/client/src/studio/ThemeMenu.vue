<script setup lang="ts">
import { Monitor, Moon, Sun } from "@lucide/vue";
import { Button } from "@/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import { dark, theme, type ThemeMode } from "./theme";

const modes: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Hell", icon: Sun },
  { value: "dark", label: "Dunkel", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon-sm" aria-label="Darstellung">
        <Moon v-if="dark" aria-hidden="true" />
        <Sun v-else aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-36">
      <DropdownMenuRadioGroup
        :model-value="theme"
        @update:model-value="theme = $event as ThemeMode"
      >
        <DropdownMenuRadioItem
          v-for="mode in modes"
          :key="mode.value"
          :value="mode.value"
          ><component :is="mode.icon" aria-hidden="true" />{{
            mode.label
          }}</DropdownMenuRadioItem
        >
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
