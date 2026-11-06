import { readLogin, saveLogin, type Store, type StoredLogin } from "./config";
import { CliError } from "./runtime/errors";
import { AUTH_REQUEST_TIMEOUT_MS, requestSignal, type Io } from "./runtime/io";

// Logging in uses Secani's MCP OAuth: discovery from the MCP server's
// protected-resource metadata, dynamic client registration with the
// authorization server, then the device authorization grant (RFC 8628), so it
// works the same on a desktop, over SSH and in a container. The refresh token
// keeps the login alive; refreshing takes a lock.

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPES = "openid offline_access";
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000;

export type AuthServer = {
  issuer: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
};

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function getJson(io: Io, url: string): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await io.fetch(url, { headers: { accept: "application/json" }, signal: requestSignal(io.signal, AUTH_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw networkError(url, error);
  }
  const text = await response.text().catch((error: unknown) => {
    throw networkError(url, error);
  });
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

export function networkError(url: string, error: unknown): CliError {
  if ((error as Error)?.name === "AbortError") throw error;
  const cause = (error as { cause?: { code?: string } })?.cause?.code;
  const reason =
    (error as Error)?.name === "TimeoutError"
      ? "No answer arrived in time."
      : cause === "ENOTFOUND" || cause === "EAI_AGAIN"
      ? "The host name didn't resolve."
      : cause === "ECONNREFUSED"
        ? "The connection was refused."
        : cause === "ETIMEDOUT" || cause === "UND_ERR_CONNECT_TIMEOUT"
          ? "The connection timed out."
          : cause?.startsWith("CERT_") || cause === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || cause === "SELF_SIGNED_CERT_IN_CHAIN"
            ? "The TLS certificate wasn't trusted. Set NODE_EXTRA_CA_CERTS if a proxy re-signs traffic."
            : "The request failed before a response arrived.";
  return new CliError({
    class: "network",
    reason: "network_error",
    message: `Couldn't reach ${hostOf(url)}. ${reason}`,
    retryable: true,
    ...(cause ? { data: { cause } } : {}),
  });
}

function platformError(message: string, detail?: string): CliError {
  return new CliError({
    class: "platform",
    reason: "api_error",
    message,
    ...(detail ? { detail: [detail] } : {}),
  });
}

/** RFC 9728 metadata of the MCP server, then RFC 8414 metadata of its authorization server. */
export async function discover(io: Io, server: string): Promise<AuthServer> {
  const resource = new URL(server);
  const path = resource.pathname.replace(/\/$/, "");
  let issuer: string | undefined;
  for (const candidate of [`/.well-known/oauth-protected-resource${path}`, "/.well-known/oauth-protected-resource"]) {
    const { status, body } = await getJson(io, new URL(candidate, resource.origin).toString());
    const servers = (body as { authorization_servers?: unknown })?.authorization_servers;
    if (status === 200 && Array.isArray(servers) && typeof servers[0] === "string") {
      issuer = servers[0];
      break;
    }
  }
  if (!issuer) {
    throw platformError(`Failed to log in. ${hostOf(server)} doesn't publish OAuth metadata.`, `Server URL      ${server}`);
  }
  const { status, body } = await getJson(io, new URL("/.well-known/oauth-authorization-server", issuer).toString());
  const metadata = body as Record<string, unknown> | undefined;
  if (status !== 200 || typeof metadata?.token_endpoint !== "string") {
    throw platformError(`Failed to log in. ${hostOf(issuer)} doesn't publish authorization server metadata.`);
  }
  return {
    issuer,
    tokenEndpoint: metadata.token_endpoint,
    ...(typeof metadata.registration_endpoint === "string" ? { registrationEndpoint: metadata.registration_endpoint } : {}),
    ...(typeof metadata.device_authorization_endpoint === "string"
      ? { deviceAuthorizationEndpoint: metadata.device_authorization_endpoint }
      : {}),
  };
}

async function postForm(io: Io, url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await io.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form),
      signal: requestSignal(io.signal, AUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError(url, error);
  }
  const text = await response.text().catch((error: unknown) => {
    throw networkError(url, error);
  });
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

/** Registers this CLI as a public OAuth client (RFC 7591). */
export async function registerClient(io: Io, auth: AuthServer, version: string): Promise<string> {
  if (!auth.registrationEndpoint) {
    throw platformError(`Failed to log in. ${hostOf(auth.issuer)} doesn't accept client registration.`);
  }
  let response: Response;
  try {
    response = await io.fetch(auth.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Secani CLI",
        software_id: "secani-cli",
        software_version: version,
        grant_types: [DEVICE_GRANT, "refresh_token"],
        response_types: ["code"],
        // The registration endpoint expects at least one redirect URI; the
        // device grant never uses it.
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
      }),
      signal: requestSignal(io.signal, AUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError(auth.registrationEndpoint, error);
  }
  const body = (await response.json().catch(() => ({}))) as { client_id?: unknown };
  if (!response.ok || typeof body.client_id !== "string") {
    throw platformError(`Failed to log in. ${hostOf(auth.issuer)} didn't register the CLI.`, `HTTP Status     ${response.status}`);
  }
  return body.client_id;
}

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

export async function requestDeviceCode(io: Io, auth: AuthServer, clientId: string, resource: string): Promise<DeviceCode> {
  if (!auth.deviceAuthorizationEndpoint) {
    throw platformError(`Failed to log in. ${hostOf(auth.issuer)} doesn't support device login.`);
  }
  const { status, body } = await postForm(io, auth.deviceAuthorizationEndpoint, {
    client_id: clientId,
    scope: SCOPES,
    resource,
  });
  if (status !== 200 || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw platformError(`Failed to log in. ${hostOf(auth.issuer)} didn't issue a login code.`, `HTTP Status     ${status}`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: String(body.verification_uri ?? ""),
    ...(typeof body.verification_uri_complete === "string" ? { verificationUriComplete: body.verification_uri_complete } : {}),
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 300,
    interval: typeof body.interval === "number" ? body.interval : 5,
  };
}

function loginFrom(auth: AuthServer, clientId: string, body: Record<string, unknown>, io: Io, previous?: StoredLogin): StoredLogin {
  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : previous?.refreshToken;
  return {
    issuer: auth.issuer,
    clientId,
    tokenEndpoint: auth.tokenEndpoint,
    accessToken: String(body.access_token),
    ...(refresh ? { refreshToken: refresh } : {}),
    expiresAt: io.now() + (typeof body.expires_in === "number" ? body.expires_in : 300) * 1000,
  };
}

/** Polls the token endpoint until the person confirms, declines, or the code expires. */
export async function pollDeviceToken(
  io: Io,
  auth: AuthServer,
  clientId: string,
  code: DeviceCode,
  resource: string,
): Promise<StoredLogin> {
  const deadline = io.now() + code.expiresIn * 1000;
  let interval = Math.max(1, code.interval) * 1000;
  while (io.now() < deadline) {
    await io.sleep(interval, io.signal);
    const { status, body } = await postForm(io, auth.tokenEndpoint, {
      grant_type: DEVICE_GRANT,
      device_code: code.deviceCode,
      client_id: clientId,
      resource,
    });
    if (status === 200 && typeof body.access_token === "string") return loginFrom(auth, clientId, body, io);
    const error = body.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (error === "access_denied") {
      throw new CliError({
        class: "authentication",
        reason: "login_denied",
        message: "Couldn't log in. The login was declined in the browser.",
        recovery: [{ instruction: "Start a new login", command: { argv: ["secani", "login"] } }],
      });
    }
    if (error === "expired_token") break;
    throw platformError(`Failed to log in. ${hostOf(auth.issuer)} rejected the login code.`, typeof error === "string" ? `Error Code      ${error}` : undefined);
  }
  throw new CliError({
    class: "authentication",
    reason: "login_expired",
    message: "Couldn't log in. The login code expired before it was confirmed.",
    recovery: [{ instruction: "Start a new login", command: { argv: ["secani", "login"] } }],
  });
}

export function loginRequired(): CliError {
  return new CliError({
    class: "authentication",
    reason: "login_required",
    message: "You're not logged in.",
    userActionRequired: true,
    actionRequired: true,
    recovery: [
      { instruction: "Log in", command: { argv: ["secani", "login"] } },
    ],
  });
}

export function loginExpired(): CliError {
  return new CliError({
    class: "authentication",
    reason: "token_expired",
    message: "Your login expired.",
    userActionRequired: true,
    actionRequired: true,
    recovery: [{ instruction: "Log in again", command: { argv: ["secani", "login"] } }],
  });
}

/**
 * The access token to send: SECANI_TOKEN when set, otherwise the stored
 * login, refreshed under a lock when it is about to expire.
 */
export async function accessToken(io: Io, store: Store, server: string, options: { force?: boolean } = {}): Promise<string> {
  const fromEnv = io.env.SECANI_TOKEN?.trim();
  if (fromEnv) {
    if (options.force) throw loginExpired();
    return fromEnv;
  }
  const login = await readLogin(store, server);
  if (!login) throw loginRequired();
  if (!options.force && login.expiresAt - EXPIRY_MARGIN_MS > io.now()) return login.accessToken;
  return await store.withLock("auth.json", io, async () => {
    // Another process may have refreshed while this one waited.
    const current = await readLogin(store, server);
    if (!current) throw loginRequired();
    if (current.accessToken !== login.accessToken && current.expiresAt - EXPIRY_MARGIN_MS > io.now()) {
      return current.accessToken;
    }
    if (!current.refreshToken) throw loginExpired();
    const { status, body } = await postForm(io, current.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: current.clientId,
      resource: server,
    });
    if (status !== 200 || typeof body.access_token !== "string") {
      if (status >= 500) {
        throw platformError(`Failed to refresh the login. ${hostOf(current.tokenEndpoint)} returned an error.`, `HTTP Status     ${status}`);
      }
      throw loginExpired();
    }
    const refreshed = loginFrom(
      { issuer: current.issuer, tokenEndpoint: current.tokenEndpoint },
      current.clientId,
      body,
      io,
      current,
    );
    await saveLogin(store, server, refreshed);
    return refreshed.accessToken;
  });
}
