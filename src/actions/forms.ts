// Every form this plugin serves is declared here with the SDK's formkit builder,
// which generates the JSON Schema and the JSON Forms UI schema from one statement
// per field. A malformed form throws at start-up (build() calls validate()),
// where it is a compile-time-shaped mistake rather than a dialog that won't open.

import { formkit } from "@inflowenger/node-plugin-sdk";
import type { FormBuilder } from "@inflowenger/node-plugin-sdk";

// ---------------------------------------------------------------- settings --

// The Gmail account a settings profile represents. This plugin holds NO Google
// credentials and runs NO OAuth: a Gmail account is connected once, centrally, in
// FloMorphic's Connect page (via OpenConnector / oomol). A settings profile just
// points at one of those connected accounts by its alias — so all this dialog
// does is let the user pick which connected Gmail account this node acts as.
//
// Press "List accounts" to see the connected Gmail accounts (email — alias) and
// copy an alias into the field; leave it empty to use the default account. The
// optional connection id scopes to one Connect connection (a specific gateway)
// when several are configured; empty spans them.
// The settings dialog is a PICK-FROM-LIST: the user connects a Gmail account once
// in FloMorphic → Connect, and here just chooses it — no text to type. Pressing
// "Load accounts" calls the list meta, which rebuilds the "Gmail account" field
// into a drop-down of the connected accounts (see registry's metaAccountList,
// which returns formkit.choose). The selected value is the account's alias.
//
// Built once (settingsForm) below; the picker meta rebuilds it with the account
// drop-down (see registry's metaAccountList, formkit.choose(settingsForm, …)).
const settingsFormDef = formkit
  .form("Gmail account (OpenConnector)")
  .describe(
    "This node acts as a Gmail account you connected in FloMorphic → Connect. Press " +
      "Load accounts and pick one — nothing to type. No Google credentials live here.",
  )
  .submitTo("gmail.meta.account.test")
  .add(
    formkit
      .text("alias", "Gmail account")
      .describe("Press ↻ to load the Gmail accounts connected in FloMorphic → Connect, then pick one. Empty uses the default account.")
      .lookup("gmail.meta.account.list", "Load accounts")
      .picks("gmail.meta.account.list"),
    formkit
      .text("connection", "Gateway (optional)")
      .describe("Advanced: pin to one Connect connection id when several gateways are configured (hosted oomol vs self-hosted). Empty spans all."),
    formkit
      .text("test", "Test account")
      .describe("Press ↻ to confirm the selected account resolves before saving.")
      .lookup("gmail.meta.account.test", "Test account"),
  );

export const settingsForm: FormBuilder = settingsFormDef.build();

// ------------------------------------------------------------------ actions --

// Field keys match OpenConnector's `gmail.send_email` input schema, so the values
// are forwarded straight through (to, cc, bcc, fromEmail, subject, body, isHtml).
export const sendForm: FormBuilder = formkit
  .form("Send email")
  .add(
    formkit
      .text("to", "To")
      .required()
      .describe("Primary recipient email address. Accepts {{$.path}} tokens, e.g. {{$.trigger.email}}."),
    formkit.text("cc", "Cc").describe("Optional. Comma-separated addresses."),
    formkit.text("bcc", "Bcc").describe("Optional. Comma-separated addresses."),
    formkit.text("fromEmail", "From").describe("Optional verified send-as alias to use in the From header; empty sends as the account."),
    formkit.text("subject", "Subject").required().describe("Subject line. Pull values from the flow inline with {{$.path}}."),
    formkit
      .textArea("body", "Body")
      .required()
      .describe("Message body. Plain text by default; tick HTML below to send markup."),
    formkit.bool("isHtml", "Send as HTML").default(false).describe("Set when the body is already HTML."),
  )
  .build();

// Field keys match `gmail.fetch_emails` (query, maxResults, detail).
export const searchForm: FormBuilder = formkit
  .form("Search messages")
  .add(
    formkit
      .text("query", "Query")
      .describe('Gmail search syntax — the same as the Gmail search box, e.g. from:boss@acme.com is:unread newer_than:2d. Empty matches the whole mailbox. Accepts {{$.path}} tokens.'),
    formkit
      .integer("maxResults", "Max results")
      .default(20)
      .between(1, 500)
      .describe("Most messages to return. Each hit costs one metadata read, so keep it modest."),
    formkit
      .text("detail", "Detail")
      .default("summary")
      .describe("How much per-message detail to return: ids, summary, or full."),
  )
  .build();

// Field key matches `gmail.get_message` (messageId).
export const getForm: FormBuilder = formkit
  .form("Get message")
  .add(
    formkit
      .text("messageId", "Message id")
      .required()
      .describe("The Gmail message id to fetch — e.g. from a Search result's messageId, or {{$.path}} to an upstream id."),
  )
  .build();

// Modify labels. NOTE: the OpenConnector label-modify action name/inputs were not
// in the confirmed catalog (truncated) — field keys (messageId/addLabelIds/
// removeLabelIds) and the OC action in registry's REQUIRES.modify are a best
// guess pending verification against GET /v1/actions?service=gmail.
export const modifyForm: FormBuilder = formkit
  .form("Modify labels")
  .describe(
    "Add and/or remove labels on a message — mark read (remove UNREAD), archive " +
      "(remove INBOX), star (add STARRED), trash (add TRASH).",
  )
  .add(
    formkit
      .text("messageId", "Message id")
      .required()
      .describe("The message to modify. A Search result's messageId, or {{$.path}} to an upstream id."),
    formkit
      .list("addLabelIds", "Add label ids")
      .describe("Label ids to add, e.g. STARRED, IMPORTANT, or a custom Label_123."),
    formkit
      .list("removeLabelIds", "Remove label ids")
      .describe("Label ids to remove, e.g. UNREAD (mark read), INBOX (archive)."),
  )
  .build();
