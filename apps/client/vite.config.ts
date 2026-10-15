import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import * as compiler from "vue/compiler-sfc";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
// Resolving imported prop types needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships.
compiler.registerTS(() =>
  createRequire(import.meta.url)("@typescript/typescript6"),
);
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(
    mode,
    fileURLToPath(new URL("../..", import.meta.url)),
    "",
  );
  if (command === "build" && env.NODE_ENV === "development")
    throw new Error(
      "NODE_ENV=development aus .env entfernen: Ein Release darf keine Entwicklungsdiagnose enthalten.",
    );
  const api = `http://127.0.0.1:${env.PORT || 43170}`;
  const suppliedRevision = process.env.LOCALTAKE_BUILD_REVISION;
  let revision: string | null =
    suppliedRevision && /^[a-f0-9]{7,40}$/.test(suppliedRevision)
      ? suppliedRevision.slice(0, 12)
      : null;
  try {
    revision ??= execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    /* Release archives may have no Git metadata. */
  }
  return {
    define: {
      __LOCALTAKE_BUILD__: JSON.stringify({
        version: JSON.parse(
          readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ).version,
        revision,
        builtAt: new Date().toISOString(),
        mode,
      }),
    },
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [vue({ compiler }), tailwindcss()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      host: "127.0.0.1",
      port: Number(env.CLIENT_PORT || 43171),
      strictPort: true,
      proxy: {
        "/api": api,
        "/ws": { target: api.replace("http", "ws"), ws: true },
        "/healthz": api,
      },
    },
    build: {
      outDir: "../../dist/client",
      emptyOutDir: true,
      target: "es2022",
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 600,
    },
  };
});
