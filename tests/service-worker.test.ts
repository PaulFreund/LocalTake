import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { serviceWorkerSource } from "../scripts/service-worker.mjs";

function worker(options: {
  index?: Response;
  asset?: Response;
  cacheFailure?: boolean;
  fetch: () => Promise<Response>;
}) {
  const handlers = new Map<string, (event: unknown) => void>();
  const network = vi.fn(options.fetch);
  const cache = {
    match: async (request: string | { url: string }) => {
      if (request === "/index.html") return options.index;
      if (
        typeof request !== "string" &&
        new URL(request.url).pathname === "/assets/app.js"
      )
        return options.asset;
      return undefined;
    },
  };
  runInNewContext(
    serviceWorkerSource("localtake-test", ["/index.html", "/assets/app.js"]),
    {
      self: {
        location: { origin: "https://studio.example.test" },
        addEventListener: (name: string, handler: (event: unknown) => void) =>
          handlers.set(name, handler),
      },
      caches: {
        open: async () => {
          if (options.cacheFailure) throw new Error("Cache unavailable");
          return cache;
        },
      },
      fetch: network,
      URL,
      Response,
    },
  );
  return {
    network,
    request(path: string, mode = "navigate", method = "GET") {
      let response: Promise<Response> | undefined;
      handlers.get("fetch")!({
        request: {
          url: new URL(path, "https://studio.example.test").href,
          method,
          mode,
        },
        respondWith: (value: Promise<Response>) => {
          response = value;
        },
      });
      return response;
    },
  };
}
const offline = async () => {
  throw new TypeError("Failed to fetch");
};

describe("offline and release navigation", () => {
  it("loads the current release online even when an older index is cached", async () => {
    const sw = worker({
      index: new Response("old release"),
      fetch: async () => new Response("current release"),
    });
    expect(await (await sw.request("/index.html")!).text()).toBe(
      "current release",
    );
  });
  it("reopens the cached studio offline for root URLs with query strings", async () => {
    const sw = worker({
      index: new Response("offline studio"),
      fetch: offline,
    });
    expect(await (await sw.request("/?retry=1")!).text()).toBe(
      "offline studio",
    );
  });
  it("returns an explicit response when offline recovery has no cached index", async () => {
    const sw = worker({ fetch: offline });
    const response = await sw.request("/")!;
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("offline");
  });
  it("still loads online when the Cache API is unavailable", async () => {
    const sw = worker({
      cacheFailure: true,
      fetch: async () => new Response("online studio"),
    });
    expect(await (await sw.request("/")!).text()).toBe("online studio");
  });
  it("uses cached immutable assets and returns 503 for unavailable uncached assets", async () => {
    const cached = worker({
      asset: new Response("cached script"),
      fetch: offline,
    });
    expect(await (await cached.request("/assets/app.js", "cors")!).text()).toBe(
      "cached script",
    );
    expect(cached.network).not.toHaveBeenCalled();
    const missing = worker({ fetch: offline });
    expect((await missing.request("/assets/app.js", "cors")!).status).toBe(503);
  });
  it("does not intercept signaling, health checks, foreign resources, or POST requests", () => {
    const sw = worker({ fetch: offline });
    for (const path of [
      "/api/rooms",
      "/healthz",
      "/ws",
      "https://other.example/index.html",
    ])
      expect(sw.request(path)).toBeUndefined();
    expect(sw.request("/", "navigate", "POST")).toBeUndefined();
  });
  it("preserves access denial instead of silently serving cached HTML", async () => {
    const sw = worker({
      index: new Response("offline studio"),
      fetch: async () => new Response("denied", { status: 403 }),
    });
    expect((await sw.request("/")!).status).toBe(403);
  });
});
