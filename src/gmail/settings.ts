// Turns the settings profile the platform ships with every call into a live,
// authenticated Gmail client.
//
// The plugin holds no Google credentials of its own. A Gmail account travels in
// each request as `body.settings` — the same named profile the runtime folds
// into action bodies — so one running plugin can serve many mailboxes and
// rotating a token needs no redeploy.
//
// Authentication is OAuth 2.0, and the plugin runs the whole grant itself. A
// settings profile carries the Google OAuth *client* (the `client_id` /
// `client_secret` from the credentials JSON Google Cloud hands you) plus the
// long-lived `refresh_token` the plugin obtained for that mailbox during set-up
// (see the OAuth buttons on the settings form). At run time the client exchanges
// the refresh token for a short-lived access token and caches it. A profile may
// instead carry a ready `access_token` directly, for callers that mint their own.

import { GmailClient } from "./client.js";

/** Error surfaced when a call arrives without a usable Gmail connection. It is
 * phrased for the person looking at the node, since that is where the fix is. */
export const ErrNoSettings =
  "this node has no Gmail connection: pick a settings profile in the node drawer, " +
  "or create one from the plugin's set-up form and complete the OAuth consent " +
  "(Get consent URL → Authorize)";

/**
 * The plugin's built-in OAuth client, read once from the environment. When the
 * operator sets these, every user signs in against this one shared Google client
 * and pastes no credentials at all — the recommended desktop-app setup. For a
 * Desktop client Google treats the secret as non-confidential, so shipping one
 * client for all users is the documented pattern (see oauth.ts).
 *
 *   GOOGLE_OAUTH_CLIENT_ID       the shared client id (required to enable this)
 *   GOOGLE_OAUTH_CLIENT_SECRET   its secret (Google still wants it at exchange)
 *   GOOGLE_OAUTH_REDIRECT        redirect uri; defaults to http://localhost
 *
 * Unset it and the plugin falls back to a per-profile credentials JSON.
 */
export function builtinApp(): Partial<OAuthApp> {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  if (clientId === "") return {};
  return {
    clientId,
    clientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim(),
    redirectUri: (process.env.GOOGLE_OAUTH_REDIRECT ?? "").trim() || DEFAULT_REDIRECT,
  };
}

/** Whether a built-in shared client is configured — the set-up form uses this to
 * tell the user they can skip pasting a credentials JSON. */
export function hasBuiltinApp(): boolean {
  return (process.env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim() !== "";
}

/** The reasonable default scopes: read/label + send, enough for every action. A
 * profile can narrow this with a `scopes` field. */
export const DEFAULT_SCOPES =
  "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const DEFAULT_REDIRECT = "http://localhost";

/** The OAuth client half of a connection — everything needed to run the consent
 * flow and exchange codes, before any per-mailbox token exists. */
export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  tokenUri: string;
  authUri: string;
  redirectUri: string;
  scopes: string;
  /** The mailbox to act on; "me" (the authenticated user) by default. */
  user: string;
}

/** A resolved, ready-to-call connection: the OAuth client plus a token to use —
 * either a refresh token (minted/refreshed on demand) or a ready access token. */
export interface Config extends OAuthApp {
  refreshToken: string;
  accessToken: string;
}

/**
 * Read the OAuth *client* out of a settings profile — the half that exists
 * before any consent has happened, so the set-up buttons (build a consent URL,
 * exchange an auth code) can run with only the credentials pasted in.
 *
 * The `client_id` / `client_secret` come from the Google credentials JSON when
 * one is pasted (installed *or* web client), or from discrete fields. Keys are
 * matched leniently: case, spaces, dashes and underscores are ignored, and the
 * usual synonyms are accepted.
 */
export function parseApp(settings: Record<string, unknown> | undefined): OAuthApp {
  if (!settings || Object.keys(settings).length === 0) {
    throw new Error(ErrNoSettings);
  }

  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(settings)) {
    const text = toStr(value);
    if (text !== "") values.set(canonicalKey(key), text);
  }

  // A profile's own credentials win; the built-in shared client fills the gaps,
  // so with a built-in client configured the profile can carry no credentials at
  // all and the user only completes consent.
  const creds = parseCredentials(pick(values, credentialsKeys));
  const builtin = builtinApp();

  const app: OAuthApp = {
    clientId: creds.clientId || pick(values, clientIdKeys) || builtin.clientId || "",
    clientSecret: creds.clientSecret || pick(values, clientSecretKeys) || builtin.clientSecret || "",
    tokenUri: creds.tokenUri || pick(values, tokenUriKeys) || DEFAULT_TOKEN_URI,
    authUri: creds.authUri || pick(values, authUriKeys) || DEFAULT_AUTH_URI,
    redirectUri:
      creds.redirectUri || pick(values, redirectKeys) || builtin.redirectUri || DEFAULT_REDIRECT,
    scopes: pick(values, scopeKeys) || DEFAULT_SCOPES,
    user: pick(values, userKeys) || "me",
  };

  if (app.clientId === "") {
    throw new Error(
      "no Google OAuth client available: set the plugin's built-in client " +
        "(GOOGLE_OAUTH_CLIENT_ID / _SECRET), or paste a credentials JSON " +
        '(the {"installed":{…}} / {"web":{…}} file from Google Cloud) into the profile',
    );
  }
  return app;
}

/**
 * Read a ready-to-call connection out of the settings profile the platform ships
 * with every call as `body.settings`. Requires the OAuth client (see parseApp)
 * plus a token: a refresh token from the completed consent flow, or a directly
 * supplied access token.
 */
export function parseConfig(settings: Record<string, unknown> | undefined): Config {
  const app = parseApp(settings);

  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(settings!)) {
    const text = toStr(value);
    if (text !== "") values.set(canonicalKey(key), text);
  }

  const cfg: Config = {
    ...app,
    refreshToken: pick(values, refreshTokenKeys),
    accessToken: pick(values, accessTokenKeys),
  };

  if (cfg.refreshToken === "" && cfg.accessToken === "") {
    throw new Error(
      "this profile has an OAuth client but no token yet: open the plugin set-up " +
        "form and complete the consent flow (Get consent URL → paste the code → Authorize)",
    );
  }
  return cfg;
}

// parseCredentials reads the Google OAuth client JSON — the `{"installed":{…}}`
// or `{"web":{…}}` file Google Cloud downloads. A user may paste the whole file
// or just the inner object; both are handled. Anything unparseable yields an
// empty app, so the discrete fields can still supply the values.
function parseCredentials(raw: string): Partial<OAuthApp> {
  if (raw.trim() === "") return {};
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  // Unwrap the installed/web envelope if present.
  const inner =
    (obj.installed as Record<string, unknown>) ||
    (obj.web as Record<string, unknown>) ||
    obj;

  const redirects = inner.redirect_uris;
  const redirectUri = Array.isArray(redirects) && redirects.length > 0 ? String(redirects[0]) : "";

  return {
    clientId: toStr(inner.client_id),
    clientSecret: toStr(inner.client_secret),
    tokenUri: toStr(inner.token_uri),
    authUri: toStr(inner.auth_uri),
    redirectUri,
  };
}

// Field synonyms, in preference order. Each entry is already canonical (lower
// case, letters and digits only) — see canonicalKey.
const credentialsKeys = ["credentials", "credentialsjson", "credential", "clientjson", "googlecredentials", "credsjson"];
const clientIdKeys = ["clientid", "oauthclientid", "googleclientid", "appid"];
const clientSecretKeys = ["clientsecret", "oauthclientsecret", "googleclientsecret", "secret"];
const refreshTokenKeys = ["refreshtoken", "oauthrefreshtoken", "googlerefreshtoken"];
const accessTokenKeys = ["accesstoken", "oauthaccesstoken", "token", "bearer", "bearertoken"];
const tokenUriKeys = ["tokenuri", "tokenurl", "tokenendpoint"];
const authUriKeys = ["authuri", "authurl", "authorizationuri", "authendpoint"];
const redirectKeys = ["redirecturi", "redirecturl", "callback", "callbackurl"];
const scopeKeys = ["scopes", "scope"];
const userKeys = ["user", "userid", "mailbox", "email", "emailaddress", "account", "from"];

function pick(values: Map<string, string>, keys: string[]): string {
  for (const key of keys) {
    const v = values.get(key);
    if (v !== undefined) return v;
  }
  return "";
}

// canonicalKey reduces a settings key to letters and digits, lower case, so
// "Client ID", "client_id" and "clientId" are one key.
function canonicalKey(key: string): string {
  let out = "";
  for (const ch of key.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out += ch;
  }
  return out;
}

// toStr renders a profile value. The settings editor stores anything that
// parses as JSON (numbers, booleans) as that type, so values are not always
// strings.
function toStr(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}

// -------------------------------------------------------------------- pool --

/**
 * Pool hands out one client per distinct connection, so every job using the
 * same settings profile shares a cached access token instead of re-authing.
 * Clients are safe for concurrent use.
 */
export class Pool {
  private clients = new Map<string, GmailClient>();
  private static readonly maxClients = 32;

  /** Resolve the settings profile shipped with a call into a client. */
  client(settings: Record<string, unknown> | undefined): GmailClient {
    const cfg = parseConfig(settings);
    return this.for(cfg);
  }

  /** Return the client for an already-parsed config. */
  for(cfg: Config): GmailClient {
    const key = fingerprint(cfg);
    const existing = this.clients.get(key);
    if (existing) return existing;

    if (this.clients.size >= Pool.maxClients) this.clients.clear();
    const client = new GmailClient(cfg);
    this.clients.set(key, client);
    return client;
  }
}

// fingerprint identifies a connection without keeping secrets in a readable map
// key. A distinct client (and token cache) exists per account + credential set.
function fingerprint(cfg: Config): string {
  const material = [cfg.user, cfg.clientId, cfg.refreshToken, cfg.accessToken].join(" ");
  // djb2 — a stable non-cryptographic hash is enough for a cache key.
  let hash = 5381;
  for (let i = 0; i < material.length; i++) {
    hash = ((hash << 5) + hash + material.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}
