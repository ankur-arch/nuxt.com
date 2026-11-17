<script setup lang="ts">
/**
 * A deploy uses the visitor's cooldown, so it takes a deliberate gesture: drag the knob to the end of the track.
 * Keyboard and assistive tech confirm by activating the knob: their clicks carry no pointer detail.
 */
const props = defineProps<{
  label: string
  /** Shown while the deploy runs, with the knob held at the end. */
  busyLabel?: string
  busy?: boolean
}>()

const emit = defineEmits<{ confirm: [] }>()

const KNOB = 56
const INSET = 4

const trackEl = useTemplateRef('track')
const offset = ref(0)
const { width } = useElementSize(trackEl)
const max = computed(() => Math.max(0, width.value - KNOB - INSET * 2))
const dragging = ref(false)
let startX = 0

const progress = computed(() => props.busy ? 1 : max.value ? offset.value / max.value : 0)

function onDown(event: PointerEvent) {
  if (props.busy) return
  dragging.value = true
  startX = event.clientX - offset.value
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
}

function onMove(event: PointerEvent) {
  if (dragging.value) offset.value = Math.min(max.value, Math.max(0, event.clientX - startX))
}

function onUp() {
  if (!dragging.value) return
  dragging.value = false
  if (max.value && offset.value >= max.value * 0.85) confirm()
  else offset.value = 0
}

/** A cancelled pointer (a system gesture, a rotation) is not a release: it never deploys. */
function onCancel() {
  dragging.value = false
  offset.value = 0
}

function confirm() {
  offset.value = max.value
  emit('confirm')
}

// The knob slides back once the deploy ends, ready for the next one.
watch(() => props.busy, (busy) => {
  if (!busy) offset.value = 0
})
</script>

<template>
  <div
    ref="track"
    class="relative h-11 rounded-full bg-elevated/30 ring ring-default select-none touch-none"
  >
    <span
      class="absolute inset-0 flex items-center justify-center text-sm tabular-nums pointer-events-none"
      :class="[busy ? 'ps-4 pe-16' : 'ps-16 pe-4', !dragging && 'transition-opacity duration-300']"
      :style="{ opacity: busy ? 1 : Math.max(0, 1 - progress * 1.6) }"
    >
      <span class="shimmer truncate">{{ busy ? busyLabel : label }}</span>
    </span>
    <button
      type="button"
      :aria-label="label"
      :disabled="busy"
      class="absolute top-1 left-1 h-9 w-14 rounded-full bg-primary text-inverted flex items-center justify-center shadow-sm shadow-primary/25 cursor-grab active:cursor-grabbing disabled:cursor-default duration-200 ease-snappy hover:bg-primary/90 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      :class="dragging ? 'transition-[background-color,scale]' : 'transition-[transform,background-color,scale]'"
      :style="{ transform: `translateX(${busy ? max : offset}px)` }"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onCancel"
      @click="$event.detail === 0 && confirm()"
    >
      <UIcon :name="busy ? 'i-lucide-loader-circle' : progress > 0.85 ? 'i-lucide-check' : 'i-lucide-arrow-right'" class="size-5" :class="busy && 'animate-spin'" />
    </button>
  </div>
</template>

<style scoped>
.shimmer {
  color: transparent;
  background: linear-gradient(90deg, var(--ui-text-muted) 40%, var(--ui-text-highlighted) 50%, var(--ui-text-muted) 60%) 0 0 / 300% 100%;
  background-clip: text;
  animation: shimmer 2.4s linear infinite;
}

@keyframes shimmer {
  from { background-position: 100% 0; }
  to { background-position: 0 0; }
}

@media (prefers-reduced-motion: reduce) {
  .shimmer {
    animation: none;
    color: var(--ui-text-muted);
  }
}
</style>
