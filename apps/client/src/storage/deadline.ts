// Only background storage operations use this deadline. Browser pickers and
// permission prompts stay under the user's control and must not time out.
export async function storageDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  label: string | (() => string),
  timeoutMs = 15_000,
  parent?: AbortSignal,
): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentAborted: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `${typeof label === "function" ? label() : label}: Nach ${timeoutMs / 1000} Sekunden noch nicht abgeschlossen. Bitte erneut versuchen oder einen anderen lokalen Ordner wählen.`,
          );
          error.name = "StorageTimeoutError";
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
      new Promise<never>((_resolve, reject) => {
        parentAborted = () => {
          controller.abort(parent?.reason);
          reject(parent?.reason);
        };
        parent?.addEventListener("abort", parentAborted, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (parentAborted) parent?.removeEventListener("abort", parentAborted);
  }
}
