# Gmail plugin for Inflowenger

An Inflowenger **plugin node** for Gmail, built on
[`@inflowenger/node-plugin-sdk`](https://www.npmjs.com/package/@inflowenger/node-plugin-sdk).
It appears on the FloMorphic / Inflowenger workflow canvas as a **GMAIL** node with
four actions and runs as an ordinary long-running Node process you deploy anywhere.

The plugin holds **no Gmail credentials of its own**. A Gmail account travels with
every call as a **settings profile** (`body.settings`) the platform manages — so one
running plugin can serve many mailboxes, and rotating a token needs no redeploy.

## Actions

| Method | Title | What it does |
|--------|-------|--------------|
| `gmail.send`   | Send email      | Send a message (`to`/`cc`/`bcc`, subject, text or HTML body). |
| `gmail.search` | Search messages | Find messages with Gmail search syntax (`q`); returns lightweight summaries. |
| `gmail.get`    | Get message     | Fetch one message in full — headers plus a best-effort text body. |
| `gmail.modify` | Modify labels   | Add/remove label ids (mark read → remove `UNREAD`, archive → remove `INBOX`, star → add `STARRED`, trash → add `TRASH`). |

Free-text fields accept `{{$.path}}` tokens, resolved against the flow context at run
time (e.g. `To = {{$.trigger.email}}`).

## Authentication — OAuth 2.0 with PKCE

The plugin runs the whole OAuth grant for you (PKCE, the flow Google documents for
desktop apps); no one ever pastes a token by hand. Setup happens **once, by the
operator**, and then **end users just sign in** — they never touch Google Cloud.

### One-time operator setup (built-in shared client — recommended)

In FloMorphic's Google Cloud project, create **one** OAuth 2.0 client of type
**Desktop app** and configure the consent screen with the Gmail scopes you need
(`.../auth/gmail.modify`, `.../auth/gmail.send`). Then set three env vars for the
plugin process:

```env
GOOGLE_OAUTH_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
GOOGLE_OAUTH_REDIRECT=http://localhost   # optional; defaults to http://localhost
```

For a Desktop client Google states the secret *"is obviously not treated as a
secret"* — so shipping one shared client for all users is the documented pattern, and
PKCE is what protects each authorization. With this set, a user's settings profile
needs **no credentials at all**.

### What each user does (no Google Console)

1. **Mailbox** — `me` (the signed-in user) or an address they can access.
2. **① Get consent URL** — press ↻; the plugin generates a PKCE challenge and builds
   the link. Open it and grant access.
3. **② Authorization code** — Google redirects to `http://localhost/?code=…`; paste
   that code (or the whole URL) and press ↻ to **Authorize**. The plugin exchanges it
   (code + PKCE verifier) and writes the **refresh token** into the read-only field.
4. **Test connection** — authenticates and reads the mailbox profile, so a wrong
   grant is caught in the dialog rather than by every node that later fails.

At run time the plugin exchanges that refresh token for short-lived access tokens and
caches them. A profile may instead carry a ready **`accessToken`** (advanced) — used
as-is but never refreshed.

### Without a built-in client (fallback)

If the `GOOGLE_OAUTH_*` env vars are unset, each profile must paste its own Google
credentials JSON (the `{"installed":{…}}` / `{"web":{…}}` file) into the optional
**Google credentials JSON** field; the rest of the flow is identical.

> If Authorize reports no refresh token, revoke the app at
> [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and run
> the two steps again — Google only returns a refresh token on fresh consent.

## Configuration

The plugin's own identity — **not** Gmail credentials — comes from a dotenv file. These
three values are minted by Infra when the plugin is defined in a space:

```env
# .env.inflow
PLUGIN_ID=aa-bbb-ccc-dddd
INFRA_CRED=LS0tLS1CRUdJTiBOQVRTIFVTRVIgSldULS0t...   # base64 of the .creds blob
INFRA_URL=localhost:4222
```

Copy `.env.inflow.example` to `.env.inflow` and fill it in. Set `INFLOW_ENV_FILE` to
point at a different file.

## Run

```bash
npm install          # installs @inflowenger/node-plugin-sdk from npm
npm run build        # tsc -> dist/
npm start            # node dist/main.js   (blocks, serving requests)
# or, during development:
npm run dev          # tsx src/main.ts
```

On startup the SDK logs each subscribed subject — that confirms registration. Add the
node to a flow, bind a settings profile, and run it.

## Layout

```
gmail/
├── src/
│   ├── main.ts              entry: intro, settings, actions, start, block
│   ├── gmail/
│   │   ├── settings.ts      parse the settings profile → OAuth client/config; client pool
│   │   ├── oauth.ts         consent-URL + auth-code exchange (set-up flow)
│   │   ├── client.ts        Gmail REST client (OAuth token refresh + send/search/get/modify/labels)
│   │   └── mime.ts          build an RFC 2822 message; flatten a fetched one
│   └── actions/
│       ├── registry.ts      actions + meta RPCs; the settings-profile → client bridge
│       ├── forms.ts         formkit forms (JSON Schema + JSON Forms UI)
│       └── vars.ts          {{$.path}} token resolution against the flow scope
└── .claude/skills/inflow-plugin/  Agent Skill for AI coding assistants
```

Built with the Node SDK; the wire protocol is identical to the Go SDK's, so this node
is interchangeable with a Go plugin from the runtime's point of view.
