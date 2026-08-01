export const abortError = (message = "The operation was aborted."): DOMException =>
  new DOMException(message, "AbortError");

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError();
};

export const raceWithAbort = <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return operation;
  if (signal.aborted) {
    // Attach a rejection handler because callers may already have started an
    // operation that cannot be cancelled, such as Obsidian requestUrl.
    void operation.catch(() => undefined);
    return Promise.reject(abortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));

    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
};
