#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

import { runCli } from "./main";
import { abortableSleep, type Io } from "./runtime/io";

// The Node entry: real streams, one root abort signal for SIGINT, SIGTERM and
// SIGHUP (the first stops local work and restores the terminal; a second
// exits at once), and quiet exits on a closed stdout.

const controller = new AbortController();
const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
let signals = 0;
for (const signal of Object.keys(SIGNAL_EXIT) as NodeJS.Signals[]) {
  process.on(signal, () => {
    signals += 1;
    if (signals > 1) process.exit(SIGNAL_EXIT[signal]);
    controller.abort(Object.assign(new DOMException("Canceled", "AbortError"), { exitCode: SIGNAL_EXIT[signal] }));
  });
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

function openUrl(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function readLine(question: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
    let answered = false;
    const onAbort = () => rl.close();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    rl.on("SIGINT", () => {
      rl.close();
      controller.abort(Object.assign(new DOMException("Canceled", "AbortError"), { exitCode: 130 }));
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => {
      controller.signal.removeEventListener("abort", onAbort);
      if (!answered) {
        process.stderr.write("\n");
        resolve(null);
      }
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const io: Io = {
  stdout: {
    write: (text) => void process.stdout.write(text),
    isTTY: process.stdout.isTTY === true,
    ...(process.stdout.columns ? { columns: process.stdout.columns } : {}),
  },
  stderr: {
    write: (text) => void process.stderr.write(text),
    isTTY: process.stderr.isTTY === true,
    ...(process.stderr.columns ? { columns: process.stderr.columns } : {}),
  },
  stdinIsTTY: process.stdin.isTTY === true,
  env: process.env,
  platform: process.platform,
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  sleep: abortableSleep,
  readLine,
  readStdin,
  openUrl,
  signal: controller.signal,
  homedir: homedir(),
};

runCli(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Unexpected error in secani. This is a bug in Secani CLI.\n  ${(error as Error)?.message ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
