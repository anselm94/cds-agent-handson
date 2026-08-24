# Day 8: Connecting Your A2A Agent to SAP Joule

On Day 7 your agent became a standards-compliant **A2A server**. That is a huge step, but it is only half the story — right now only clients that know the A2A protocol can talk to it. In this session you will plug it into **SAP Joule**, SAP's enterprise AI copilot, using the *Bring Your Own Agent* (pro-code) approach: a business user will be able to open Joule and chat with your bookshop agent in natural language, with multi-turn memory, without ever seeing a JSON-RPC request.

> Joule is the **A2A client** here. Your CAP app on Cloud Foundry stays the **A2A server** from Day 7 — you do not change the agent, you change *how Joule discovers and reaches it*.

---

## How Joule and your agent talk

Before touching any files, it is worth understanding the contract Joule expects, because it shapes the changes below. Joule integrates with code-based agents via the **Agent2Agent protocol v0.3.0** — and it supports only a subset of its mechanisms:

1. **Synchronous `message/send`.** When a scenario fires, Joule prepares an A2A `message/send` request containing the user's utterance and waits for the agent to finish. Joule expects a response within **60 seconds**.
2. **The answer is read from the terminal *status message*.** Joule extracts the final answer from `result.body.status.message.parts[0].text` — i.e. the message embedded in the task's final `status-update` event. Joule does **not** consume `artifact-update` events (the Day 7 `createMessageUpdate` path). This is the single most important constraint and drives Step 1.
3. **Discovery through a BTP destination.** The capability references a *system alias*, which maps to a *BTP destination*, which points at your deployed agent. Joule fetches the agent card from the destination URL and uses it to locate the A2A endpoint.
4. **Multi-turn via `contextId`/`taskId`.** The agent generates both IDs; the Joule capability captures them from the response and sends them back on the next request. Your executor already maps `contextId` → LangGraph `thread_id`, so the conversation just continues.

Because Joule's synchronous call waits for the task to reach a terminal state, intermediate updates such as "Thinking..." are not shown to the user — the capability itself displays an "Invoking Agent" status instead.

---

## Step 1 — Make the executor Joule-compatible

Open `srv/a2a/a2a-executor.js` and `srv/a2a/a2a-utils.js`. Three small changes make the agent's output land where Joule looks for it.

### 1.1 Leave the intermediate "Thinking..." status update in place

Keep the `working` status update published right after the task is created:

```js
    if (!existingTask) {
      eventBus.publish(createNewTask(contextId, taskId, userMessage));
    }

    eventBus.publish(
      createTaskUpdate(contextId, taskId, "Thinking...", "working"),
    );
```

It is an intermediate, **non-final** update — `createTaskUpdate` now marks only `input-required` events as `final: true` (Step 1.2) — so Joule's synchronous `message/send` ignores it: Joule reads the answer only from the task's *terminal* status message, and the capability already shows its own "Invoking Agent" status while the agent works. The `working` event simply falls through the noise, so you can leave it in place.

### 1.2 Make only `input-required` status updates final

Tighten the `final` flag in `srv/a2a/a2a-utils.js` so that only the clarifying-question interrupt is marked as the terminal event:

```diff
-    final:
-      status !== "working" && status !== "submitted" && status !== "unknown",
+    final: status === "input-required",
```

**Why:** In A2A, `final: true` on a status update is what tells a *streaming* client to stop and, for an interrupt, wait for the user. The synchronous `message/send` path Joule uses does not need it — the request ends when the executor calls `eventBus.finished()` (Step 1.3). Marking `working`, `completed`, and `failed` as non-final also makes the old trailing empty `completed` update from Day 7 removable — see Step 1.3.

### 1.3 Deliver the answer as a status message, not an artifact

Restructure the tail of `execute()` in `srv/a2a/a2a-executor.js`. In the non-interrupted success branch, replace the artifact update with a terminal status update that carries the answer as its message:

```diff
       } else {
         const msg = res.messages[res.messages.length - 1].content;
-        eventBus.publish(
-          createMessageUpdate(contextId, taskId, msg, false, true),
-        );
-        eventBus.finished();
+        eventBus.publish(createTaskUpdate(contextId, taskId, msg, "completed"));
       }
     } catch (error) {
       LOG.error(`Error executing agent: ${error}`);
       eventBus.publish(
         createTaskUpdate(contextId, taskId, `Error: ${error}`, "failed"),
       );
-      eventBus.finished();
-      return;
     }
 
-    eventBus.publish(
-      createTaskUpdate(contextId, taskId, undefined, "completed"),
-    );
     eventBus.finished();
```

**Why:** Day 7 published the answer as a `TaskArtifactUpdateEvent` (`kind: "artifact-update"`). Joule supports only a limited set of A2A v0.3.0 mechanisms and reads the answer from the task's final **status message** (`status.message.parts[0].text`). By publishing a `createTaskUpdate(..., "completed")` instead, the answer is embedded in the terminal status — exactly where `call_agent.yaml` (Step 6) extracts it.

Two things make this safe:

- **`eventBus.finished()` is now called exactly once**, at the end of `execute()`, on every path (success, interrupt, error). With Step 1.2's `final` logic, the old trailing `createTaskUpdate(..., undefined, "completed")` update — which Day 7 used to close the task — must be **removed**: it would otherwise republish a `completed` status *without* a message and overwrite the answer in the task store.
- The `input-required` branch stays as-is — `createTaskUpdate(..., "input-required")` already delivers its question through the status message (marked `final: true` by Step 1.2), which is the correct mechanism for Joule to surface clarifying questions.

---

## Step 2 — Redeploy the agent to Cloud Foundry

Joule reaches your agent through its public URL, so the changes from Step 1 must be live. Rebuild and redeploy the CAP application exactly as in Day 5:

```bash
mbt build
cf deploy mta_archives/*.mtar
```

You need the HTTPS route for Step 3. Sanity-check that the A2A endpoint is reachable:

```bash
curl https://<your-app-route>/a2a/.well-known/agent.json
```

The agent card should come back with `"url"` pointing at `https://<your-app-route>/a2a`.

---

## Step 3 — Create the BTP destination

Joule does not call your agent's URL directly. The `agent-request` action goes through a **BTP destination**, which decouples your capability YAML from the physical URL of your agent — you can change the URL later without redeploying the capability.

1. Open the SAP BTP Cockpit and navigate to your subaccount → **Connectivity → Destinations**.
2. Choose **New Destination** and enter:

   | Field             | Value                                                |
   | ----------------- | ---------------------------------------------------- |
   | Name              | `a2a_bookshop_<identity>` (e.g. `a2a_bookshop_jdoe`) |
   | Type              | `HTTP`                                               |
   | URL               | `https://<your-app-route>/a2a`                       |
   | Authentication    | `OAuth2ClientCredentials`                            |
   | Description       | `A2A bookshop agent for Joule`                       |
   | Client ID         | `<your-client-id>`                                   |
   | Client Secret     | `<your-client-secret>`                               |
   | Token Service URL | `https://<your-ias-tenant>/oauth2/token`             |
   | Proxy Type        | `Internet`                                           |
   

3. Save, then click the destination and **Check Connection** to verify BTP can reach your agent card.

> **Why the URL ends in `/a2a`?** Discovery is relative to the agent's root. The agent card lives at `/.well-known/agent.json` *relative to where the A2A server is mounted* — which for us is `/a2a/.well-known/agent.json`. Pointing the destination at `<route>/a2a` lets Joule find the card and, from it, the JSON-RPC endpoint.

---

## Step 4 — Install the Joule Studio CLI

The **Joule Studio CLI** is the command-line tool for building, compiling, deploying, and testing Joule capabilities — think of it as *`cf push` but for Joule*.

```bash
npm install -g @sap/joule-studio-cli
```

It gives you commands for the full lifecycle: `joule login`, `joule compile` (Design-Time Artifacts → a `.daar` archive), `joule deploy`, `joule launch`, `joule list`, and more.

---

## Step 5 — Add `joule:*` npm scripts

Add the following scripts to `package.json` so the Joule workflow is a single `npm run` away:

```json
"scripts": {
  "start": "cds-serve",
  "joule:login": "joule login --no-app-tid",
  "joule:list": "joule list",
  "joule:compile": "joule compile ./joule-capability ./joule-capability",
  "joule:deploy": "joule deploy ./joule-capability/da.sapdas.yaml",
  "joule:launch": "joule launch a2a_bookshop_<identity>"
}
```

| Script          | What it does                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `joule:login`   | Authenticates the CLI with your Joule tenant (`--no-app-tid` skips the app tenant-ID prompt)       |
| `joule:list`    | Lists all deployed assistants — handy to see that you deployed yours                               |
| `joule:compile` | Compiles the Design-Time Artifacts under `./joule-capability` into a `.daar` archive (same folder) |
| `joule:deploy`  | Deploys the digital assistant described by `da.sapdas.yaml` to Joule                               |
| `joule:launch`  | Opens the deployed assistant in the Joule web client                                               |

> Replace `<identity>` in `joule:launch` with the same identity you used in Step 3 — it must match the assistant name in `da.sapdas.yaml` (Step 6).

---

## Step 6 — Create the Joule capability

A **capability** is a YAML package that tells Joule *what* your agent can do, *how* to reach it, and *how* to render its responses. No runtime code on the Joule side — just YAML.

| Concept                | What it is                                                      | In this project                                                |
| ---------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| **Digital Assistant**  | Top-level manifest that assembles capabilities                  | `da.sapdas.yaml`                                               |
| **Capability**         | A package of skills added to Joule                              | `capability.sapdas.yaml`                                       |
| **Scenario**           | A user-facing skill description Joule matches questions against | `scenarios/invoke_agent.yaml`                                  |
| **Function**           | The executable logic a scenario triggers                        | `functions/call_agent.yaml`                                    |
| **System Alias**       | A named reference to a BTP destination                          | `BookshopAssistantA2A` → destination `a2a_bookshop_<identity>` |
| **Capability Context** | Session-scoped variables persisting across turns                | `capability_context.yaml` (`contextId`, `taskId`)              |

Create the folder structure:

```bash
mkdir -p joule-capability/functions joule-capability/scenarios
```

### 6.1 The digital assistant descriptor — `joule-capability/da.sapdas.yaml`

The root manifest the CLI reads to know which capabilities to compile and deploy:

```yaml
schema_version: 1.4.0
name: a2a_bookshop_<identity>
capabilities:
  - type: local
    folder: ./
```

`name` is the deployed assistant's name — use your identity and keep it in sync with `joule:launch`.

### 6.2 The capability — `joule-capability/capability.sapdas.yaml`

```yaml
schema_version: 3.28.0

metadata:
  namespace: joule.ext
  name: a2a_bookshop_<identity>
  version: 1.0.0
  display_name: A2A Bookshop Assistant
  description: Bookshop assistant A2A agent for SAP Joule

system_aliases:
  BookshopAssistantA2A:
    destination: a2a_bookshop_<identity>
```

- **`schema_version: 3.28.0`** — the minimum DTA schema version that supports code-based agents via the `agent-request` action. A lower version fails at compile time.
- **`namespace: joule.ext`** — **required** for custom capabilities. Any other namespace is treated as SAP-internal and deployment fails.
- **`system_aliases`** — maps the alias `BookshopAssistantA2A` (used in the function) to the BTP destination `a2a_bookshop_<identity>` you created in Step 3.

### 6.3 The capability context — `joule-capability/capability_context.yaml`

Session-scoped variables that Joule persists across turns of a conversation. They hold the agent-generated IDs so they can be sent back on the next request:

```yaml
variables:
  - name: contextId
  - name: taskId
```

### 6.4 The function — `joule-capability/functions/call_agent.yaml`

This is the heart of the integration. The `agent-request` action delegates to your A2A agent and the following actions wire the response back:

```yaml
parameters:
  - name: contextId
    optional: true
  - name: taskId
    optional: true

action_groups:
  - actions:
      - type: status-update
        message: <? "Invoking Agent" ?>

      - type: agent-request
        agent_type: remote
        system_alias: BookshopAssistantA2A
        body: >
          <? (contextId == null || contextId.isEmpty()) && (taskId == null || taskId.isEmpty())
             ? null
             : '{ "contextId": "' + contextId + '", "taskId": "' + taskId + '" }' ?>
        result_variable: result

      - type: set-variables
        variables:
          - name: contextId
            value: <? result.body.contextId ?>
          - name: taskId
            value: <? result.body.id ?>

      - type: message
        message:
          type: text
          content: "<? result.body.status.message.parts[0].text ?>"
          markdown: true

result:
  contextId: "<? contextId ?>"
  taskId: "<? taskId ?>"
```

Walking through the actions:

- **`status-update`** — Joule shows an "Invoking Agent" status to the user while your agent works. This is why the executor's own intermediate `working` update is not needed for the user experience — it stays in place but is ignored by Joule (Step 1).
- **`agent-request`** — calls your agent over A2A. `agent_type: remote` marks this as a **code-based** agent hosted outside Joule (use `local` for Joule-internal content agents). `system_alias` resolves to your BTP destination. The `body` sends the current `contextId`/`taskId` — or `null` on the first turn — so the agent can resume the right conversation. The full A2A response lands in the `result` variable.
- **`set-variables`** — captures the IDs the *agent* generated (`result.body.contextId`, `result.body.id`) into the capability context, so the next request in this conversation sends them back. This is how multi-turn memory survives across requests.
- **`message`** — renders the answer. `result.body.status.message.parts[0].text` is precisely the terminal status message your executor publishes in Step 1.3.
- **`result`** — returns the IDs to the scenario so it can update the capability context.

### 6.5 The scenario — `joule-capability/scenarios/invoke_agent.yaml`

A scenario is the user-facing skill. Joule matches the user's question against the `description` and, when triggered, runs the function:

```yaml
description: >
  Use to get the list of books, details and operations for the bookshop

target:
  type: function
  name: call_agent
  parameters:
    - name: contextId
      value: $capability_context.contextId
    - name: taskId
      value: $capability_context.taskId

capability_context:
  - name: contextId
    value: $target_result.contextId
  - name: taskId
    value: $target_result.taskId
```

- **`description`** — the trigger. Keep it descriptive of what the bookshop agent can do (book lists, details, stock operations) so Joule's intent matching routes questions to it.
- **`target`** — which function to run and where its parameters come from (the capability context).
- **`capability_context`** — feeds the IDs returned by the function back into the session context, closing the loop for the next turn.

---

## Step 7 — Login to SAP Joule

Authenticate the CLI against your Joule tenant:

```bash
npm run joule:login
```

Follow through the prompts and enter the credentials for your SAP Joule account. When prompted, choose your shared training tenant.

---

## Step 8 — Compile the project into a `*.daar` file

Compile the Design-Time Artifacts into a Runtime Artifact Archive:

```bash
npm run joule:compile
```

This validates your YAML against the schemas and produces `joule-capability/joule.ext_a2a_bookshop_<identity>_1.0.0.daar`.

> The compiled `.daar` archive is gitignored — it is a build artifact, not source.

---

## Step 9 — Deploy the project to SAP Joule

Deploy the digital assistant described by `da.sapdas.yaml`:

```
npm run joule:deploy
```

Confirm it shows up (with your unique name) in the list of deployed assistants:

```
npm run joule:list
```

---

## Step 10 — Launch the project in SAP Joule

Open the deployed assistant in the Joule web client:

```
npm run joule:launch
```

This opens a browser with your standalone assistant. Try it out:

- **"Find me the books that are cheaper than 15?"** — Joule matches the scenario, calls your agent via A2A, and shows the answer extracted from the terminal status message.
- **"Update the book - <book-id> with 3 more in stock"** — a follow-up.

Your agent is now reachable from Joule's conversational UI by any business user. Next steps: secure the integration with IAS App2App trust, replace `MemorySaver`/`InMemoryTaskStore` with durable stores, and publish your capability to the main `sap_digital_assistant` instead of a standalone assistant.

### References

- [Joule Development Guide — Install and Update Joule Studio CLI](https://help.sap.com/docs/joule/joule-development-guide-ba88d1ec6a1b442098863d577c19b0c0/install-and-update-joule-studio-cli)
- [Joule Development Guide — Code-Based Agents (Bring Your Own Agent)](https://help.sap.com/docs/joule/joule-development-guide-ba88d1ec6a1b442098863d577c19b0c0/code-based-agents-bring-your-own-agent)
- [SAP Architecture Center — Integrating AI Agents with Joule](https://architecture.learning.sap.com/docs/ref-arch/ae6821)
- [A2A Protocol Specification v0.3](https://a2a-protocol.org/v0.3.0/specification)
