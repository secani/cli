import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "./runtime/errors";
import type { Io } from "./runtime/io";

// The CLI config directory holds the login (auth.json) and preferences
// (config.json), both owner-only. Every write goes to a randomly named
// temporary file in the same directory and is renamed into place, so an
// interrupted write never leaves a truncated file. Broken files are errors,
// never treated as absent or reset.

export const DEFAULT_SERVER_URL = "https://mcp.secani.com/mcp";

export function serverUrl(io: Io): string {
  const configured = io.env.SECANI_MCP_URL?.trim();
  if (!configured) return DEFAULT_SERVER_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new CliError({
      class: "config",
      reason: "invalid_config",
      message: `SECANI_MCP_URL isn't a URL: ${JSON.stringify(configured)}.`,
      recovery: [{ instruction: "Set it to the Secani MCP endpoint, such as https://mcp.secani.com/mcp, or unset it." }],
    });
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function configDir(io: Io): string {
  const explicit = io.env.SECANI_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  if (io.platform === "win32" && io.env.APPDATA) return join(io.env.APPDATA, "secani");
  const xdg = io.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(io.homedir, ".config"), "secani");
}

export type StoredLogin = {
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch millis. */
  expiresAt: number;
};

export type AuthFile = { version: 1; servers: Record<string, StoredLogin> };
export type ConfigFile = { version: 1; servers: Record<string, { workspace?: string }> };

export class Store {
  constructor(readonly dir: string) {}

  private path(file: string): string {
    return join(this.dir, file);
  }

  async read<T extends { version: 1 }>(file: "auth.json" | "config.json", empty: T): Promise<T> {
    let text: string;
    try {
      text = await readFile(this.path(file), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CliError({
        class: "config",
        reason: "invalid_config",
        message: `${this.path(file)} isn't valid JSON. ${(error as Error).message.replace(/^.*?: /, "")}`,
        recovery: [{ instruction: `Fix or delete ${this.path(file)}, then run the command again.` }],
      });
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { servers?: unknown }).servers !== "object"
    ) {
      throw new CliError({
        class: "config",
        reason: "invalid_config",
        message: `${this.path(file)}: "version" must be 1 and "servers" an object.`,
        recovery: [{ instruction: `Fix or delete ${this.path(file)}, then run the command again.` }],
      });
    }
    return parsed as T;
  }

  async write(file: "auth.json" | "config.json", value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.path(file);
    const temporary = this.path(`.${file}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /**
   * Runs work while holding `<file>.lock`, so two CLI processes refreshing the
   * same login don't both spend the refresh token. A lock older than 30 s is
   * stale and removed; every request made under it times out sooner
   * (AUTH_REQUEST_TIMEOUT_MS), so a live holder never looks stale. The lock
   * names its owner, and a process removes only a lock it still owns.
   */
  async withLock<T>(file: string, io: Io, work: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = this.path(`${file}.lock`);
    const owner = randomBytes(8).toString("hex");
    const deadline = io.now() + 15_000;
    for (;;) {
      try {
        const handle = await open(lock, "wx", 0o600);
        try {
          await handle.writeFile(owner);
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await stat(lock).catch(() => undefined);
        // File times are wall-clock times, so staleness uses the wall clock.
        if (info && Date.now() - info.mtimeMs > 30_000) {
          await unlink(lock).catch(() => undefined);
          continue;
        }
        if (io.now() > deadline) {
          throw new CliError({
            class: "conflict",
            reason: "conflict",
            message: "Can't refresh the login. Another secani process holds the lock.",
            context: [["Lock", lock]],
            recovery: [{ instruction: `Wait for the other process, or delete ${lock} if none is running.` }],
          });
        }
        await io.sleep(100, io.signal);
      }
    }
    try {
      return await work();
    } finally {
      const holder = await readFile(lock, "utf8").catch(() => undefined);
      if (holder === owner) await unlink(lock).catch(() => undefined);
    }
  }
}

export async function readLogin(store: Store, server: string): Promise<StoredLogin | undefined> {
  const file = await store.read<AuthFile>("auth.json", { version: 1, servers: {} });
  return file.servers[server];
}

export async function saveLogin(store: Store, server: string, login: StoredLogin | undefined): Promise<void> {
  const file = await store.read<AuthFile>("auth.json", { version: 1, servers: {} });
  if (login) file.servers[server] = login;
  else delete file.servers[server];
  await store.write("auth.json", file);
}

export async function readSavedWorkspace(store: Store, server: string): Promise<string | undefined> {
  const file = await store.read<ConfigFile>("config.json", { version: 1, servers: {} });
  return file.servers[server]?.workspace;
}

export async function saveWorkspace(store: Store, server: string, workspace: string): Promise<void> {
  const file = await store.read<ConfigFile>("config.json", { version: 1, servers: {} });
  file.servers[server] = { ...file.servers[server], workspace };
  await store.write("config.json", file);
}
