// Everything the CLI touches outside its own code goes through one Io, so
// tests drive the whole CLI with fake streams, a fake clock and a fake fetch,
// and no command reads process.* itself.

export type OutStream = {
  write(text: string): void;
  isTTY: boolean;
  /** Display width when known (a TTY); undefined otherwise. */
  columns?: number;
};

export type Io = {
  stdout: OutStream;
  stderr: OutStream;
  stdinIsTTY: boolean;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Asks one question on stderr and returns the typed line, or null on EOF/cancel. */
  readLine(question: string, options?: { mask?: boolean }): Promise<string | null>;
  /** Reads all of stdin as text (for `-` inputs). */
  readStdin(): Promise<string>;
  /** Opens a URL in the desktop browser; resolves false when it couldn't. */
  openUrl(url: string): Promise<boolean>;
  /** Root abort signal: SIGINT, SIGTERM and SIGHUP. */
  signal: AbortSignal;
  homedir: string;
};

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** How long one request to the sign-in service may take; below the 30 s stale-lock age. */
export const AUTH_REQUEST_TIMEOUT_MS = 20_000;
/** How long one MCP request may take; just above the server's 60 s limit. */
export const MCP_REQUEST_TIMEOUT_MS = 70_000;

/** The root signal, also aborted with a TimeoutError after `ms`. */
export function requestSignal(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}
