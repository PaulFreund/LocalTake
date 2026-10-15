import { ref, watch } from "vue";

export type ThemeMode = "system" | "light" | "dark";
const key = "localtake-theme";
const system = matchMedia("(prefers-color-scheme: dark)");
const saved = (): ThemeMode => {
  try {
    const value = localStorage.getItem(key);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
};

export const theme = ref<ThemeMode>(saved());
export const dark = ref(false);
// Mirrors public/theme.js, which applies the same choice before the first paint.
const apply = () => {
  dark.value =
    theme.value === "dark" || (theme.value === "system" && system.matches);
  document.documentElement.classList.toggle("dark", dark.value);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark.value ? "#0a0a0a" : "#ffffff");
};
system.addEventListener("change", apply);
watch(
  theme,
  (mode) => {
    try {
      if (mode === "system") localStorage.removeItem(key);
      else localStorage.setItem(key, mode);
    } catch {
      /* Theme storage is optional. */
    }
    apply();
  },
  { immediate: true },
);
