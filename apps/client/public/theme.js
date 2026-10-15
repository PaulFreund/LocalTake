// Applies the saved or system color scheme before the first paint; the CSP forbids inline scripts.
try {
  const mode = localStorage.getItem("localtake-theme");
  const dark =
    mode === "dark" ||
    (mode !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0a0a0a" : "#ffffff");
} catch {
  /* The application applies the theme again after loading. */
}
