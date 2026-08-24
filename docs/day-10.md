# Day 10: Connecting Your Agent to the MCP Server

On Day 9 you exposed **S/4HANA Sales Order data** as an MCP server — and consumed it *manually*, clicking through tools in VS Code's MCP Tool Explorer. Today you close the loop: your LangChain bookshop agent becomes an **MCP client** and consumes those tools *programmatically*. Instead of hand-coding every tool like you did on Day 6 (`get_books`, `update_stock`), the agent will **discover** whatever tools the MCP server publishes at startup and add them to its toolbox.

The result is an agent with two distinct skills: it still manages the bookshop through its own tools, and it answers S/4HANA sales-order questions through the remote `describe` and `query` tools coming over MCP.

> **Client vs. server:** Day 9 made your CAP app an MCP *server* (via the `@cap-js/mcp` protocol adapter). Today we use `@langchain/mcp-adapters` on the consumer side — the bridge that turns MCP tools into first-class LangChain tools.

---

# Part 1 — Run both apps side-by-side

## Step 1 — Install the LangChain MCP adapters

Open a terminal in the `agent/` app and install the adapters package:

```bash
cd agent

npm install @langchain/mcp-adapters
```

This adds the `MultiServerMCPClient` class — one client that can talk to several MCP servers at once and expose their tools to LangChain.

---

## Step 2 — Run the MCP server on port 4005

Locally you will now run **two CAP apps at once**: the agent (default port `4004`) and the MCP server from Day 9. Give the MCP app a dedicated port so the two do not collide. Add a convenience script to `mcp/package.json`:

```diff
  "scripts": {
    "start": "cds-serve",
+   "watch": "cds watch --port 4005"
  },
```

From now on, start the MCP server with:

```bash
cd mcp

npm run watch
```

> The MCP endpoint is served at `/mcp/sales-order` — derived from the annotated service path (Day 9, Step 13). So locally the full URL is `http://localhost:4005/mcp/sales-order`.

---

# Part 2 — Locate the MCP server

Your agent needs to answer one question before it can call any tool: **where is the MCP server?** On your laptop it is `localhost:4005`; in production it is a Cloud Foundry route behind IAS authentication. You solve this the same way SAP applications always do — with a **destination**: one lookup that works everywhere, no hardcoded URLs in your agent code.

## Step 3 — Create destination-aware helpers

Create `agent/srv/mcp/utils.js` with two helpers built on the SAP Cloud SDK connectivity module:

```javascript
import {
  getDestination,
  buildHeadersForDestination,
} from "@sap-cloud-sdk/connectivity";

export async function resolveDestinationUrl(destinationName) {
  const resolvedDest = await getDestination({ destinationName });
  return resolvedDest?.url ?? "";
}

export async function resolveDestinationHeaders(destinationName) {
  try {
    const resolvedDest = await getDestination({ destinationName });
    if (!resolvedDest) return {};

    const rawHeaders = await buildHeadersForDestination(resolvedDest);
    // Cloud SDK returns lowercase header keys (e.g. "authorization") —
    // normalize to title-case so HTTP clients handle them correctly.
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).map(([k, v]) => [
        k.replace(/(^|-)(.)/g, (_, sep, c) => sep + c.toUpperCase()),
        v,
      ]),
    );
    return headers;
  } catch (error) {
    return {};
  }
}
```

What each helper does:

- **`resolveDestinationUrl`** — looks up a destination by name.
- **`resolveDestinationHeaders`** — uses `buildHeadersForDestination` to produce ready-to-send auth headers for the destination. For an `OAuth2ClientCredentials` destination this fetches a fresh access token and wraps it in an `Authorization: Bearer ...` header — no manual token handling in your code.

> `@sap-cloud-sdk/connectivity` ships transitively with `@sap/cds` — no extra install needed.

---

## Step 4 — Configure the `mcp-salesorders-<identity>` destination

The agent refers to the MCP server by the destination name **`mcp-salesorders-<identity>`** — replace `<identity>` with your IAS identity, e.g. `mcp-salesorders-anselm`. Align the local example file `agent/.env.example` accordingly:

```properties
AICORE_SERVICE_KEY={"serviceurls":{"AI_API_URL":"https://..."},"clientid":"...","clientsecret":"...","url":"https://..."}
destinations=[{"name": "mcp-salesorders-<identity>", "url": "http://localhost:4005/mcp/sales-order"}]
```

> Note the URL carries the **full MCP path** `/mcp/sales-order`. The helper from Step 3 uses `destination.url` verbatim — no path is appended later.

For production, create the destination once in the BTP Cockpit — exactly like the Joule destination on Day 8, but pointing at your MCP app:

1. Open the SAP BTP Cockpit and navigate to your subaccount → **Connectivity → Destinations**.
2. Choose **New Destination** and enter:

   | Field             | Value                                              |
   | ----------------- | -------------------------------------------------- |
   | Name              | `mcp-salesorders-<identity>`                       |
   | Type              | `HTTP`                                             |
   | URL               | `https://<your-deployment-url>/mcp/sales-order`    |
   | Authentication    | `OAuth2ClientCredentials`                          |
   | Description       | `MCP server for S/4HANA sales orders`              |
   | Client ID         | `<your-client-id>`                                 |
   | Client Secret     | `<your-client-secret>`                             |
   | Token Service URL | `https://<your-ias-tenant>/oauth2/token`           |
   | Proxy Type        | `Internet`                                         |

   Use the same IAS client credentials you stored in `mcp/test/http/.env` on Day 9.

3. Save, then click the destination and **Check Connection** to verify BTP can reach the MCP endpoint.

---

# Part 3 — Wire the tools into the agent

## Step 5 — Discover tools from the MCP server

Open `agent/srv/agents/bookshop-agent.js` and add the imports plus a `getMcpTools` function below your hand-written tools:

```diff
  import { getA2aServerUrl } from "../a2a/a2a-utils.js";
+ import { MultiServerMCPClient } from "@langchain/mcp-adapters";
+ import {
+   resolveDestinationUrl,
+   resolveDestinationHeaders,
+ } from "../mcp/utils.js";
```

```javascript
const getMcpTools = async () => {
  const destinationName = "mcp-salesorders-<identity>";
  const mcpUrl = await resolveDestinationUrl(destinationName);

  const mcpClient = new MultiServerMCPClient({
    mcpServers: {
      "salesorder-mcp": {
        url: mcpUrl,
      },
    },
    beforeToolCall: async () => {
      const headers = await resolveDestinationHeaders(destinationName);
      return { headers: headers };
    },
  });

  return await mcpClient.getTools(["salesorder-mcp"], {
    headers: await resolveDestinationHeaders(destinationName),
  });
};
```

Three things happen here:

- **Connection** — `MultiServerMCPClient` connects to the MCP endpoint over streamable HTTP (the transport your CAP adapter serves).
- **Discovery** — `getTools()` fetches the server's tool list over MCP and converts everything it finds (`describe` and `query`) into LangChain tools, descriptions included. Add a new entity or action on the server tomorrow, and the agent picks it up on its next start — no agent-side code changes.
- **`beforeToolCall`** — a hook invoked *before every single tool execution*. It attaches freshly resolved auth headers to each outgoing request. Tokens are fetched per call, so an expired access token can never break a session mid-conversation.

> **Why resolve the URL twice?** `getMcpTools` runs once at startup to know *where* to connect. `beforeToolCall` runs on every invocation to know *how to authenticate* — credentials can rotate or expire, URLs rarely do.

---

## Step 6 — Turn the agent into an async factory

Fetching MCP tools is asynchronous network I/O — but module-level code cannot be async. So instead of exporting a finished `bookshopAgent` constant, export an async **factory function** and let the callers `await` it:

```diff
-export const bookshopAgent = createAgent({
-  model: model,
-  systemPrompt: "You are a helpful SAP assistant.",
-  tools: [getBooksTool, updateStockTool],
-  checkpointer: checkpointer,
-});
+export const getAgent = async () => {
+  const mcpTools = await getMcpTools();
+
+  return createAgent({
+    model: model,
+    systemPrompt: "You are a helpful SAP assistant.",
+    tools: [getBooksTool, updateStockTool, ...mcpTools],
+    checkpointer: checkpointer,
+  });
+};
```

The agent's own tools stay untouched — the spread operator `...mcpTools` simply appends whatever the MCP server offers.

Update the two call sites.

**`agent/srv/agent-service.js`** (REST invoke path):

```diff
-import { bookshopAgent } from "./agents/bookshop-agent.js"
+import { getAgent } from "./agents/bookshop-agent.js"
```

```diff
      messages: [{ role: "user", content: message }],
    };

+   const bookshopAgent = await getAgent();
    const result = await bookshopAgent.invoke(agentInputs);
```

**`agent/srv/server.js`** (A2A path — the agent is built once when the server boots):

```diff
  const taskStore = new InMemoryTaskStore();

+ const bookshopAgent = await getAgent();
  const agentExecutor = new LangChainAgentExecutor(bookshopAgent);
```

Finally, remove the now-unused `createMessageUpdate` import from `agent/srv/a2a/a2a-executor.js`:

```diff
-import {
-  createMessageUpdate,
-  createNewTask,
-  createTaskUpdate,
-} from "./a2a-utils.js";
+import { createNewTask, createTaskUpdate } from "./a2a-utils.js";
```

> **Why not fetch the tools lazily inside each invoke?** Both entry points construct the agent once — REST per-request would rebuild it on every message, and the A2A executor wants a stable instance at bootstrap. Building at startup keeps latency out of the conversation path.

---

## Step 7 — Teach the agent its second role

An agent only reaches for tools it knows exist, and the system prompt steers *which* role it plays. Update it in `bookshop-agent.js`:

```diff
-    systemPrompt: "You are a helpful SAP assistant.",
+    systemPrompt:
+      "You are a helpful assistant. You have 2 distinct roles: 1) You can provide information about books and update stock in the bookshop. 2) You can retrieve sales orders in the SAP S/4HANA system.",
```

---

# Part 4 — Test end-to-end

## Step 8 — Test locally with mixed prompts

Run both apps in two terminals:

```bash
# Terminal 1 — the MCP server on :4005
cd mcp && npm run watch

# Terminal 2 — the agent on :4004
cd agent && cds watch
```

Then send requests to the REST endpoint (LOCAL section of `agent/test/http/AgentService.http`). First, prove the new skill works:

```http
POST http://localhost:4004/odata/v4/agent/invoke
Content-Type: application/json
Authorization: Basic alice:

{
  "message": "Show me the top 5 sales orders including their items"
}
```

Watch the logs in Terminal 2: the agent should pick the MCP `query` tool, filter for `SalesOrders` with `$expand=to_Item` and `top=5`, and summarize real S/4HANA data.

Then confirm the old skills still work — the agent must choose between its own tools and the remote ones:

```json
{ "message": "Which books cost less than 20?" }
```

```json
{ "message": "Increase the stock of the book 'A Wizard of Earthsea' by 5" }
```

If all three prompts succeed, your agent now fluidly switches between the local bookshop and the remote S/4HANA gateway.

---

## Step 9 — Add destination service

The agent CAP service needs the **Destination Service** to resolve destinations in production. Add it to `agent/mta.yaml`:

```bash
cds add destination
```

---

## Step 10 — Redeploy the agent and test remotely

The production path exercises what Step 3 and 4 set up: the deployed agent resolves the `mcp-salesorders-<identity>` destination and lets the Cloud SDK handle OAuth. Rebuild and redeploy the agent as usual:

```bash
cd agent

mbt build
cf deploy mta_archives/*.mtar
```

Then run the REMOTE section of `agent/test/http/AgentService.http`: execute the `login` request to obtain an access token from IAS, followed by the same `invoke` request against `{{server}}/odata/v4/agent/invoke`.

> Prerequisite checklist if the deployed agent fails to answer sales-order questions: the `mcp-salesorders-<identity>` destination exists (Step 4), its URL includes the `/mcp/sales-order` path, and **Check Connection** succeeds.

You can also re-run the day-8 Joule capability — ask Joule for *"the top sales orders"* and watch the A2A path drive the very same MCP-backed agent.

## References

- [`@langchain/mcp-adapters` on npm](https://www.npmjs.com/package/@langchain/mcp-adapters)
- [Model Context Protocol — Introduction](https://modelcontextprotocol.io/)
- [CAP — Model Context Protocol Adapter](https://cap.cloud.sap/docs/guides/protocols/mcp)
- [SAP Cloud SDK — Connectivity Service](https://sap.github.io/cloud-sdk/docs/js/features/connectivity)
- [Day 9: Exposing S/4HANA Data as an MCP Server with CAP](./day-9.md)
