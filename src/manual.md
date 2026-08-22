# Gmail (OpenConnector)

Send, search, read, and label messages as a Gmail account that is connected
**centrally** in **FloMorphic → Connect** (via OpenConnector / oomol).

This node holds **no Google credentials** and makes **no Google calls**. It is a
request builder: its settings pick which connected account to act as (by alias),
and every action asks the FloMorphic backend to run the matching OpenConnector
action as that account. The backend holds the credential.

> **Runtime credential:** because this node reaches FloMorphic's central
> services (`flomorphic.svc.oc.*`), it must run with an **OPEN (multi)** runtime
> credential. A strict, plugin-scoped credential cannot publish there.

## Setup

1. Connect a Gmail account in **FloMorphic → Connect**.
2. Add this node and open its settings.
3. Press **List accounts** to load the connected Gmail accounts, then pick one.
4. Press **Test account** to confirm the chosen alias resolves.

## Actions

| Action | What it does |
| --- | --- |
| **Send email** | Send an email from the connected account. |
| **Search messages** | Find messages with Gmail search syntax. |
| **Get message** | Fetch one message in full. |
| **Modify labels** | Add and/or remove labels on a message. |

Each action checks — in the node, before running — that the chosen account has
the OpenConnector capability the action needs, so an under-scoped account fails
with a clear message instead of a raw gateway error.

## Try the settings metas

The blocks below are live. Press **Run** to call the meta through the host proxy
and see the raw JSON reply — the same calls the settings dialog makes.

**List the connected Gmail accounts** (backs the *List accounts* button):

```inflow-meta
gmail.meta.account.list
```

**Resolve / test an account** (backs the *Test account* button — with no alias it
resolves the default account):

```inflow-meta
gmail.meta.account.test
Account List
Call Account
```
