// Every form this plugin serves is declared here with the SDK's formkit builder,
// which generates the JSON Schema and the JSON Forms UI schema from one statement
// per field. A malformed form throws at start-up (build() calls validate()),
// where it is a compile-time-shaped mistake rather than a dialog that won't open.

import { formkit } from "@inflowenger/node-plugin-sdk";
import type { FormBuilder } from "@inflowenger/node-plugin-sdk";

// ---------------------------------------------------------------- settings --

// The Gmail account a settings profile represents. The platform stores the
// answers as a named, reusable profile and ships them with every call as
// body.settings; the plugin keeps nothing.
//
// Authentication is OAuth 2.0 with PKCE and the plugin runs the whole grant. When
// the operator has configured a built-in shared Google client (GOOGLE_OAUTH_*),
// the user pastes nothing — they just complete consent from the two buttons.
// Otherwise they paste their own Google credentials JSON first. "Get consent URL"
// generates a PKCE challenge and builds the authorization link; "Authorize"
// exchanges the code the user pastes back, with the PKCE verifier, for a refresh
// token — which the handler writes into the (read-only) Refresh token field so
// the platform stores it with the profile.
export const settingsForm: FormBuilder = formkit
  .form("Gmail account")
  .describe(
    "Stored by the platform as a reusable settings profile and shipped with every " +
      "call as body.settings. The plugin keeps nothing. Set-up: press Get consent " +
      "URL, grant access, then paste the code from the redirect and press Authorize. " +
      "If the plugin has no built-in Google client, paste your credentials JSON first.",
  )
  .submitTo("gmail.meta.ping.check")
  .add(
    formkit
      .text("user", "Mailbox")
      .default("me")
      .describe('Which mailbox to act on. "me" is the authenticated user; or an address the credentials can access.'),
    formkit
      .textArea("credentials", "Google credentials JSON (optional)")
      .describe('Only needed when the plugin has no built-in Google client. Paste the OAuth client file from Google Cloud — the {"installed":{…}} (Desktop) or {"web":{…}} object. You never paste a token by hand.'),
    formkit
      .text("scopes", "Scopes")
      .default("https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send")
      .describe("Space-separated OAuth scopes to request. The default covers all four actions (read/label + send); narrow it if you only read or only send."),
    formkit
      .text("authUrl", "1 · Get consent URL")
      .describe("Press ↻ to build the Google consent URL (PKCE), then open it and grant access. The link appears here.")
      .lookup("gmail.meta.oauth.url", "Get consent URL"),
    formkit
      .textArea("authCode", "2 · Authorization code")
      .describe("After granting access Google redirects to the client's redirect URI (e.g. http://localhost/?code=…). Paste that code — or the whole redirected URL — here, then press ↻ to authorize.")
      .lookup("gmail.meta.oauth.exchange", "Authorize"),
    formkit
      .secret("pkceVerifier", "PKCE verifier")
      .describe("Set automatically by Get consent URL and cleared after Authorize. Do not edit.")
      .option("readonly", true),
    formkit
      .secret("refreshToken", "Refresh token")
      .describe("Filled in automatically by Authorize. You normally never touch this; it is what lets the plugin mint access tokens for this mailbox.")
      .option("readonly", true),
    formkit
      .secret("accessToken", "Access token (optional)")
      .describe("Advanced: a ready short-lived access token. Given, it is used directly and never refreshed, so it expires. Leave empty when using the consent flow above."),
    formkit
      .text("test", "Test connection")
      .describe("Press ↻ to authenticate and read the mailbox profile before saving.")
      .lookup("gmail.meta.ping.check", "Test connection"),
  )
  .build();

// ------------------------------------------------------------------ actions --

export const sendForm: FormBuilder = formkit
  .form("Send email")
  .add(
    formkit
      .text("to", "To")
      .required()
      .describe("Recipient address, or several separated by commas. Accepts {{$.path}} tokens, e.g. {{$.trigger.email}}."),
    formkit.text("cc", "Cc").describe("Optional. Comma-separated addresses."),
    formkit.text("bcc", "Bcc").describe("Optional. Comma-separated addresses."),
    formkit.text("from", "From").describe('Optional sender override, e.g. "Support <support@acme.com>". Must be an identity the account may send as; empty sends as the account.'),
    formkit.text("subject", "Subject").required().describe("Subject line. Pull values from the flow inline with {{$.path}}."),
    formkit
      .textArea("body", "Body")
      .required()
      .describe("Message body. Plain text by default; tick HTML below to send markup."),
    formkit.bool("html", "Send as HTML").default(false).describe("Treat the body as text/html instead of text/plain."),
  )
  .build();

export const searchForm: FormBuilder = formkit
  .form("Search messages")
  .add(
    formkit
      .text("q", "Query")
      .describe('Gmail search syntax — the same as the Gmail search box, e.g. from:boss@acme.com is:unread newer_than:2d. Empty matches the whole mailbox. Accepts {{$.path}} tokens.'),
    formkit
      .integer("maxResults", "Max results")
      .default(25)
      .between(1, 500)
      .describe("Most messages to return. Each hit costs one metadata read, so keep it modest."),
  )
  .build();

export const getForm: FormBuilder = formkit
  .form("Get message")
  .add(
    formkit
      .text("id", "Message id")
      .required()
      .describe("The Gmail message id to fetch — e.g. from a Search result's id, or {{$.path}} to an upstream id."),
  )
  .build();

// modifyFormDef is kept as the builder (not just the built form) because the
// label picker rebuilds the dialog from it, splicing the discovered labels into
// the add/remove drop-downs. See the labels meta in registry.ts.
export const modifyFormDef = formkit
  .form("Modify labels")
  .describe(
    "Add and/or remove labels on a message — mark read (remove UNREAD), archive " +
      "(remove INBOX), star (add STARRED), trash (add TRASH). Press ↻ to load this " +
      "mailbox's label ids.",
  )
  .add(
    formkit
      .text("id", "Message id")
      .required()
      .describe("The message to modify. A Search result's id, or {{$.path}} to an upstream id."),
    formkit
      .list("addLabelIds", "Add label ids")
      .describe("Label ids to add, e.g. STARRED, IMPORTANT, or a custom Label_123. Press ↻ on the field below to list this mailbox's labels.")
      .lookup("gmail.meta.labels.pick", "Load labels"),
    formkit
      .list("removeLabelIds", "Remove label ids")
      .describe("Label ids to remove, e.g. UNREAD (mark read), INBOX (archive)."),
  );

export const modifyForm: FormBuilder = modifyFormDef.build();
