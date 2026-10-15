<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { Volume2 } from "@lucide/vue";
import { Button } from "@/ui/components/button";
import { act } from "./state";

const props = defineProps<{
  stream: MediaStream | null;
  muted?: boolean;
  /** Keeps the element playing (remote audio) while the picture is off. */
  hidden?: boolean;
}>();
const video = ref<HTMLVideoElement>();
const blocked = ref(false);
watch(
  [video, () => props.stream],
  ([element, stream]) => {
    if (!element) return;
    element.srcObject = stream;
    if (stream)
      void element
        .play()
        .then(() => (blocked.value = false))
        .catch(() => (blocked.value = true));
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (video.value) video.value.srcObject = null;
});
const unblock = () =>
  act(async () => {
    await video.value?.play();
    blocked.value = false;
  });
</script>

<template>
  <video
    ref="video"
    autoplay
    playsinline
    :muted="muted"
    class="absolute inset-0 size-full object-contain"
    :class="{ 'opacity-0': hidden }"
  />
  <Button
    v-if="blocked && !muted"
    size="sm"
    variant="secondary"
    class="absolute top-1/2 left-1/2 -translate-1/2"
    @click="unblock"
    ><Volume2 aria-hidden="true" />Ton aktivieren</Button
  >
</template>
