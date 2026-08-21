# Gmail (OpenConnector) — `gmail-oc`

A FloMorphic **plugin node** for Gmail that authenticates through FloMorphic's
central **Connect** feature (OpenConnector / oomol), built on
[`@inflowenger/node-plugin-sdk`](https://www.npmjs.com/package/@inflowenger/node-plugin-sdk).

It appears on the workflow canvas as a **Gmail (OpenConnector)** node with four
actions. It holds **no Google credentials** and makes **no Google API calls** —
it is a *request builder*. A Gmail account is connected **once, centrally**, in
**FloMorphic → Connect**; this node just picks which connected account to act as,
and asks the FloMorphic backend to run each action for it.

> Why the name? This plugin depends on FloMorphic's central auth. A future
> `gmail` plugin could instead talk to Google directly with its own OAuth — the
> `-oc` suffix keeps that door open.

## How it works

The FloMorphic backend is a **generic proxy**: it stores the OpenConnector token
and forwards any request over one NATS subject, `flomorphic.svc.oc.proxy`,
injecting the auth header. It knows nothing about Gmail. **All** Gmail knowledge —
which accounts exist, what an action needs, which OpenConnector endpoint to
call — lives in this plugin.

```
 gmail-oc node                     FloMorphic backend            OpenConnector gateway
 (builds + vets the request)       (injects auth, forwards)      (oomol cloud / self-host)
   │  flomorphic.svc.oc.proxy                │                            │
   │  {method,path,body,connection?}         │  <method> <path>           │
   ├──────────── NATS req ──────────────────▶│  + Authorization header ──▶│
   │◀──────────── {status,body} ─────────────┤◀───────────────────────────┤
```

The plugin uses that one proxy to:
1. `GET /v1/connections` → the connected Gmail accounts (filtered to `gmail`);
2. check the chosen account's `scopes` against what the action needs;
3. `POST /v1/actions/gmail.<action>?alias=…` → run it as that account.

- The plugin never sees a Google token. The backend holds the OpenConnector
  credential and performs the call.
- One connected account can be shared by many nodes; rotating it happens in the
  Connect page, no plugin redeploy.

## Set-up (pick from a list — nothing to type)

1. **Connect a Gmail account** once in FloMorphic → **Connect** (it shows as
   connected there, e.g. `you@gmail.com`).
2. On the node, open **settings**, press **Load accounts**, and **pick** your
   Gmail account from the drop-down. (Leave it on the default to use the default
   account.) Press **Test account**, then **Save** — the platform stores this as a
   reusable **settings profile**.
3. On any Gmail node, bind that profile in the node drawer.

There is **no** Google credentials JSON, OAuth consent, alias to copy, or token to
paste — the account list is populated live from Connect, and you just choose one.
The optional **Gateway** field pins to one Connect connection when several are
configured (hosted oomol vs self-hosted); leave it empty to span all.

## Actions

| Method | Title | Input (built by the node, forwarded to OpenConnector) |
|--------|-------|--------|
| `gmail.send`   | Send email      | `to`/`cc`/`bcc`, `subject`, `body`, `html` |
| `gmail.search` | Search messages | `q`, `maxResults` |
| `gmail.get`    | Get message     | `id` |
| `gmail.modify` | Modify labels   | `id`, `addLabelIds`, `removeLabelIds` |

Inputs accept `{{$.path}}` tokens resolved against the flow scope.

**Capability check — against oomol's own requirement.** The plugin binds each
canvas action to an OpenConnector action name (`OC_ACTION` in
[`registry.ts`](src/actions/registry.ts)). It does **not** hardcode the required
scopes: before running, it reads them **live from oomol** —
`GET /v1/actions/gmail.<action>` → `requiredScopes` (cached) — and checks the
chosen account's `scopes` against that. An under-scoped account fails here with a
clear message; oomol remains the authoritative gate. Nothing app-specific is in
the backend or web UI.

Confirmed against `GET /v1/actions?service=gmail` (scopes shown are what oomol
reports; the plugin reads them at runtime):

| Action | OpenConnector action | Scope (from oomol) | Input keys (match OC schema) |
|--------|----------------------|-------|------------------------------|
| Send email      | `gmail.send_email`   | `gmail.compose` | `to`, `cc`, `bcc`, `fromEmail`, `subject`, `body`, `isHtml` |
| Search messages | `gmail.fetch_emails` | `gmail.read`    | `query`, `maxResults`, `detail` |
| Get message     | `gmail.get_message`  | `gmail.read`    | `messageId` |
| Modify labels   | `gmail.modify_message_labels` *(name unverified)* | *(live)* | `messageId`, `addLabelIds`, `removeLabelIds` |

> **Modify labels** wasn't in the confirmed catalog dump — verify its action name
> and inputs against `GET /v1/actions?service=gmail` and adjust `OC_ACTION.modify`
> in [`registry.ts`](src/actions/registry.ts) and `modifyForm` in
> [`forms.ts`](src/actions/forms.ts). Its scope is read live like the others.

## Install

Nothing special — install it like any other plugin: add it from its GitHub repo
on the FloMorphic extension **Add plugin** page. Its runtime credential reaches
the `flomorphic.svc.*` subjects out of the box (the NATS token allows
`flomorphic.svc.>`), so an ordinary plugin credential works.

The one prerequisite is a Gmail connection: complete it once in FloMorphic →
**Connect**, where you connect the Gmail app through oomol OpenConnector. After
that the node's account drop-down populates live from Connect and the plugin runs.

## Develop

```bash
npm install
npm run build   # tsc → dist/
npm start       # node dist/main.js   (reads .env.inflow)
npm run dev     # tsx src/main.ts
```
