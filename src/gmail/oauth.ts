// The interactive half of OAuth 2.0 — building the consent URL and exchanging
// the authorization code for a refresh token — using PKCE, the flow Google
// documents for installed / desktop apps. These run during plugin set-up (from
// the settings form's buttons), not on the hot path; the runtime token refresh
// lives in client.ts.
//
// The flow is the standard installed-app / loopback grant with PKCE:
//
//   1. generatePkce → a random verifier and its S256 challenge;
//   2. buildConsentUrl(app, challenge) → the user opens it and grants access;
//   3. Google redirects to the client's redirect_uri (e.g. http://localhost)
//      with ?code=… — the user copies that code back;
//   4. exchangeCode(app, code, verifier) trades the code for a refresh token
//      (access_type=offline), which the plugin patches into the settings profile.
//
// PKCE (RFC 7636) binds the code to the verifier the same client generated, so a
// stolen authorization code is useless without it. Google still requires the
// client_secret in the exchange even with PKCE — but for a Desktop client that
// secret is, in Google's words, "not treated as a secret", so one shared client
// can be embedded in the plugin for every user (see settings.ts builtinApp).

import { createHash, randomBytes } from "node:crypto";
import type { OAuthApp } from "./settings.js";

/** A PKCE pair: the secret verifier (kept until the exchange) and the challenge
 * derived from it (sent in the consent URL). */
export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Generate a PKCE verifier + S256 challenge. The verifier is 32 random bytes as
 * base64url (43 chars), within RFC 7636's 43–128 range. */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** Build the Google consent URL for this OAuth client, scopes and PKCE challenge.
 * `access_type=offline` + `prompt=consent` are what make Google return a refresh
 * token (and return one again on re-consent, not only on the first grant). */
export function buildConsentUrl(app: OAuthApp, challenge: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: "code",
    scope: app.scopes,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${app.authUri}?${params.toString()}`;
}

export interface ExchangedTokens {
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
  scope: string;
}

/**
 * Exchange an authorization code for tokens, presenting the PKCE verifier that
 * matches the challenge sent in the consent URL. Google may URL-escape the code
 * in the redirect (e.g. `4%2F0A…`); it is decoded here so a pasted value works
 * either way.
 */
export async function exchangeCode(
  app: OAuthApp,
  code: string,
  verifier: string,
): Promise<ExchangedTokens> {
  const params = new URLSearchParams({
    code: decodeMaybe(code.trim()),
    client_id: app.clientId,
    // Google requires the secret even with PKCE; for a Desktop client it is not
    // confidential. Sent only when present, so a truly secretless client works
    // too if Google ever allows it for this project.
    ...(app.clientSecret ? { client_secret: app.clientSecret } : {}),
    redirect_uri: app.redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });

  const resp = await fetch(app.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`authorization code exchange failed (${resp.status}): ${describeError(text)}`);
  }
  const token = JSON.parse(text) as {
    refresh_token?: string;
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!token.refresh_token) {
    throw new Error(
      "no refresh_token in the response — this usually means consent was granted " +
        "before; revoke the app's access at myaccount.google.com/permissions and " +
        "run Get consent URL → Authorize again",
    );
  }
  return {
    refreshToken: token.refresh_token,
    accessToken: token.access_token ?? "",
    expiresIn: token.expires_in ?? 3600,
    scope: token.scope ?? "",
  };
}

/** base64url without padding — the encoding RFC 7636 specifies for PKCE. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// decodeMaybe undoes one layer of percent-encoding if the value looks encoded,
// so pasting the raw `code` query param (still `%2F`-escaped) works.
function decodeMaybe(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function describeError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string; error_description?: string };
    if (parsed.error_description) return parsed.error_description;
    if (parsed.error) return parsed.error;
  } catch {
    // not JSON — fall through
  }
  return text.trim() || "(no response body)";
}
