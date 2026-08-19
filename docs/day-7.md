# Day 7: Exposing Your Agent as an A2A Server — The Agent2Agent Protocol

On Day 6 your agent learned to call tools against a CAP service, but it still speaks only through your own `AgentService`. In this session you will make it speak a **standard protocol** so other agents and platforms (SAP Joule, Copilot, and any A2A-compliant client) can discover and talk to it.

> **Renamed since Day 6:** the agent is now **`bookshop-agent`** instead of `hello-world`. As the training gets serious, it's no longer a toy project. Follow along by renaming `srv/agents/hello-world-agent.js` → `srv/agents/bookshop-agent.js` and the exported agent `helloAgent` → `bookshopAgent` (also update the import in `srv/agent-service.js`). All snippets from here on use the new name.

We will use the [Agent2Agent (A2A) Protocol](https://a2a-protocol.org) — an open standard from the Linux Foundation that defines how autonomous agents communicate. An A2A server publishes:

- An **Agent Card** — a JSON "business card" describing who the agent is, what it can do, and where to reach it. The card is hosted at the A2A well-known location `/.well-known/agent.json` — relative to the *agent's* root. We mount the agent at `/a2a`, so the card lives at `/a2a/.well-known/agent.json` while CAP's root stays `/`.
- **Tasks** — the fundamental unit of work. Each task has a lifecycle (`submitted` → `working` → `input-required` / `completed` / `failed` / `canceled`).
- **Messages & Artifacts** — what is exchanged during a task. Messages are conversation turns; artifacts are the outputs produced.
- **Operations over JSON-RPC** — `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, etc.

Everything is event-driven: the agent publishes *events* on a bus (task created, status changed, message produced) and the SDK translates them into protocol responses, including streaming.

We will implement the A2A server side using the official JavaScript SDK `@a2a-js/sdk`, which implements protocol [v0.3](https://a2a-protocol.org/v0.3.0/specification).

---

## Step 1 — Install the A2A JavaScript SDK

Install the SDK that implements the A2A protocol spec:

```bash
npm install @a2a-js/sdk@0.3
```

This adds `@a2a-js/sdk` to `package.json`. The package's Express integration (`@a2a-js/sdk/server/express`) declares `express` as a peer dependency — you already have it transitively via CAP, so no extra install is needed.

> The SDK implements protocol version `0.3.x`. Joule — at the moment supports only `0.3.x`.

---

## Step 2 — Give the agent persistent memory

A2A is inherently **multi-turn**: a client can keep sending follow-up messages to the *same* task (`contextId`), and a task can be resumed after a human decision. Your agent needs to remember prior state across those turns.

LangChain's `createAgent` compiles a LangGraph state machine. To make its state persist, attach a **checkpointer** — here an in-memory one from LangGraph:

```javascript
import { MemorySaver } from "@langchain/langgraph";

const checkpointer = new MemorySaver();

export const bookshopAgent = createAgent({
  model: model,
  systemPrompt: "You are a helpful SAP assistant.",
  tools: [getBooksTool, updateStockTool],
  checkpointer: checkpointer,
});
```

The checkpointer stores the graph state keyed by a `thread_id`. We will map A2A's `contextId` to that `thread_id`, so every message of one conversation resumes the same agent run.

> `MemorySaver` keeps state in process memory — perfect for a demo. In production you would swap in a durable saver (e.g. a `@mi8y/cds-langgraph-persistence` CDS checkpoint store) so state survives restarts.

---

## Step 3 — Publish an Agent Card

An A2A server must describe itself. Add an exported `AgentCard` constant to `srv/agents/bookshop-agent.js`:

```javascript
export const AgentCard = {
  name: "bookshop-agent",
  description: "Provides information about books and allows updating stock.",
  url: getA2aServerUrl(),
  provider: { organization: "Anselm", url: "https://example.com" },
  version: "1.0.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [
    {
      id: "get-books",
      name: "Get Books",
      description: "Gets the list of books from the bookshop",
      tags: ["books"],
      examples: ["List all books", "List books with a minimum price of 20"],
      outputModes: ["text/plain"],
    },
    {
      id: "update-stock",
      name: "Update Stock",
      description: "Updates the stock of a book in the bookshop",
      tags: ["books", "stock"],
      examples: [
        "Increase stock of book with name - 'My book' by 5",
        "Decrease stock of book with ID 2 by 3",
      ],
      outputModes: ["text/plain"],
    },
  ],
  supportsAuthenticatedExtendedCard: false,
  protocolVersion: "0.3.0",
};
```

Key fields:

- **`name` / `description` / `version`** — identity. Clients use these to decide whether this agent is relevant.
- **`url`** — where the A2A service lives. We derive it from `getA2aServerUrl()` (Step 4) so it points at `http://localhost:4004/a2a` locally and the CF application URL when deployed.
- **`provider`** — who runs this agent (here: `Anselm`).
- **`capabilities`** — the feature set the agent declares. `streaming: true` lets clients use `message/stream`; `pushNotifications: false` tells clients webhook updates are *not* supported.
- **`defaultInputModes` / `defaultOutputModes`** — supported MIME types (`text`).
- **`skills`** — the units of ability this agent can perform, with example prompts clients can try.
- **`protocolVersion`** — the A2A protocol version implemented (`0.3.0`).

The `url` helper comes from the A2A utilities you create next.

---

## Step 4 — Create A2A event helpers

Create the folder `srv/a2a/` and inside it `srv/a2a/a2a-utils.js`. This module has two jobs:

1. Factory functions that build the A2A **events** our executor publishes on the event bus.
2. A helper that resolves the server's base URL.

```javascript
import cds from "@sap/cds";

export function createNewTask(contextId, taskId, message) {
  return {
    kind: "task",
    contextId: contextId,
    id: taskId,
    status: { state: "submitted", timestamp: new Date().toISOString() },
    history: [message],
    metadata: message.metadata,
  };
}

export function createTaskUpdate(contextId, taskId, message, status) {
  const statusMessage =
    typeof message === "string"
      ? createMessage(contextId, taskId, message)
      : message;
  return {
    kind: "status-update",
    taskId: taskId,
    contextId: contextId,
    status: {
      state: status,
      timestamp: new Date().toISOString(),
      message: statusMessage,
    },
    final:
      status !== "working" && status !== "submitted" && status !== "unknown",
  };
}

export function createMessageUpdate(
  contextId,
  taskId,
  message,
  append = false,
  lastChunk = true,
) {
  return {
    kind: "artifact-update",
    taskId: taskId,
    contextId: contextId,
    artifact: {
      artifactId: cds.utils.uuid(),
      parts: [{ kind: "text", text: message }],
    },
    append: append,
    lastChunk: lastChunk,
  };
}

export function createInterruptUpdate(message, options) {
  return {
    kind: "status-update",
    taskId: options.taskId,
    contextId: options.contextId,
    status: {
      state: "input-required",
      message: {
        kind: "message",
        role: "agent",
        messageId: cds.utils.uuid(),
        parts: [{ kind: "text", text: message }],
        taskId: options.taskId,
        contextId: options.contextId,
      },
      timestamp: new Date().toISOString(),
    },
    final: false,
  };
}

export function createMessage(contextId, taskId, message) {
  return {
    kind: "message",
    messageId: cds.utils.uuid(),
    role: "agent",
    parts: [{ kind: "text", text: message }],
    taskId: taskId,
    contextId: contextId,
  };
}

const VCAP = process.env.VCAP_APPLICATION;
export const getA2aServerUrl = () =>
  VCAP
    ? `https://${JSON.parse(VCAP).application_uris[0]}/a2a`
    : "http://localhost:4004/a2a";
```

What each factory emits:

- **`createNewTask`** — a `Task` event with state `submitted`, created when a client's message starts a brand-new task.
- **`createTaskUpdate`** — a `TaskStatusUpdateEvent` reporting a lifecycle change (`working`, `input-required`, `completed`, `failed`, …). The `final` flag tells the SDK that no further updates follow (only true for terminal states).
- **`createMessageUpdate`** — a `TaskArtifactUpdateEvent` carrying the agent's answer as a `text` artifact. `append`/`lastChunk` support chunked streaming delivery.
- **`createInterruptUpdate`** — a `TaskStatusUpdateEvent` with state `input-required`, used when the agent pauses to ask the human something.
- **`createMessage`** — a plain `Message` object, embedded inside status updates so clients see *why* a state changed.
- **`getA2aServerUrl`** — resolves the agent's public URL. Locally it returns `http://localhost:4004/a2a`; on Cloud Foundry it reads the route from the injected `VCAP_APPLICATION` env var.

---

## Step 5 — Bridge LangGraph to the A2A event bus

Now create `srv/a2a/a2a-executor.js`. The SDK's `DefaultRequestHandler` does all the protocol bookkeeping (JSON-RPC, task store, streaming) but it needs one thing from you: an **agent executor** — a class implementing the `AgentExecutor` interface with two methods, `execute(ctx, eventBus)` and `cancelTask(taskId, eventBus)`.

`LangChainAgentExecutor` adapts our LangChain agent to that interface by turning LangGraph's state into A2A events:

```javascript
import { Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import cds from "@sap/cds";
import {
    createMessageUpdate,
    createNewTask,
    createTaskUpdate,
} from "./a2a-utils.js";

const LOG = cds.log("a2a-agent");

export class LangChainAgentExecutor {
  #agent;

  constructor(agent) {
    this.#agent = agent;
  }

  async execute(ctx, eventBus) {
    const userMessage = ctx.userMessage;
    const existingTask = ctx.task;
    const taskId = existingTask?.id || cds.utils.uuid();
    const contextId =
      userMessage.contextId || existingTask?.contextId || cds.utils.uuid();

    const textParts = userMessage.parts.filter((part) => part.kind === "text");
    const messageText = textParts.map((part) => part.text).join(" ");

    LOG.info(
      `Executing agent with contextId: ${contextId} and taskId: ${taskId} for userMessage: ${messageText}`,
    );

    const config = {
      context: {
        id: cds.context?.id,
        user: cds.context?.user?.id,
        tenant: cds.context?.tenant,
      },
      configurable: { thread_id: contextId },
    };

    if (!existingTask) {
      eventBus.publish(createNewTask(contextId, taskId, userMessage));
    }

    eventBus.publish(
      createTaskUpdate(contextId, taskId, "Thinking...", "working"),
    );

    try {
      const state = await this.#agent.graph.getState(config);

      let res;
      if (ctx.task || state.tasks.length > 0) {
        const decision = messageText.toLowerCase().includes("approve")
          ? "approve"
          : messageText.toLowerCase().includes("reject")
            ? "reject"
            : null;
        res = await this.#agent.invoke(
          new Command({
            resume: { decisions: [{ type: decision }] }, // or "reject"
          }),
          config,
        );
      } else {
        res = await this.#agent.invoke(
          {
            messages: [{ role: "user", content: messageText }],
          },
          config,
        );
      }

      if (isInterrupted(res)) {
        const requests = [];
        for (const i of res[INTERRUPT]) {
          for (const actionRequest of i.value.actionRequests) {
            requests.push(actionRequest.description);
          }
        }
        const msg = requests.join("\n");
        eventBus.publish(
          createTaskUpdate(contextId, taskId, msg, "input-required"),
        );
      } else {
        const msg = res.messages[res.messages.length - 1].content;
        eventBus.publish(
          createMessageUpdate(contextId, taskId, msg, false, true),
        );
        eventBus.finished();
      }
    } catch (error) {
      LOG.error(`Error executing agent: ${error}`);
      eventBus.publish(
        createTaskUpdate(contextId, taskId, `Error: ${error}`, "failed"),
      );
      eventBus.finished();
      return;
    }

    eventBus.publish(
      createTaskUpdate(contextId, taskId, undefined, "completed"),
    );
    eventBus.finished();
  }

  cancelTask = async (taskId, eventBus) => {};
}
```

Walking through `execute`:

1. **Identify the conversation.** `taskId` identifies this unit of work; `contextId` identifies the conversation. Both come from the request if present, otherwise fresh UUIDs are generated.
2. **Extract the text.** A2A messages are made of typed `parts`; we join the `text` parts into one prompt.
3. **Build the LangGraph config.** The A2A `contextId` is mapped to the checkpointer's `thread_id` (Step 2), so every message in one conversation resumes the same agent state. CDS request context (user, tenant) is attached for later use.
4. **Announce the task.** If it's new, publish a `task` event (`submitted`), then a `working` status update so clients see the agent is thinking.
5. **Run the agent — two flavors:**
   - **New task / nothing pending:** invoke the agent with a fresh user message.
   - **Existing task or pending work:** resume with a `Command`, feeding the human's decision (`approve` / `reject`) back into LangGraph. This is how multi-turn and human-in-the-loop approvals work.
6. **React to the outcome.** If the run was **interrupted** (`isInterrupted`), the agent paused to ask the human for a decision — collect the pending `actionRequests` and publish an `input-required` status. Otherwise, publish the final answer as an artifact update and signal completion via `eventBus.finished()`.
7. **Handle errors.** Any exception becomes a `failed` status update, and the event bus is closed.

`cancelTask` is left as a no-op stub in this session — a minimal A2A server can get by without it; the SDK will report the task as not cancelable.

> The interrupt/resume path maps to LangChain's human-in-the-loop middleware, which pauses the graph before a tool call and resumes it with `Command({ resume })`. The executor is written to support it whenever that middleware is added.

---

## Step 6 — Mount the A2A server in CAP

Finally, create `srv/server.js`. CAP lets you hook into the Express app it builds via the `bootstrap` event. This is where the A2A endpoints get mounted — independent of (and alongside) your existing `AgentService` OData endpoint:

```javascript
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import cds from "@sap/cds";
import express from "express";
import { LangChainAgentExecutor } from "./a2a/a2a-executor.js";
import {
  bookshopAgent,
  AgentCard as BookshopAgentCard,
} from "./agents/bookshop-agent.js";

const LOG = cds.log("a2a-agent");

cds.on("bootstrap", async (app) => {
  const routerA2A = express.Router();
  routerA2A.use(cds.middlewares.before);

  const taskStore = new InMemoryTaskStore();
  const agentExecutor = new LangChainAgentExecutor(bookshopAgent);

  // A2A JSON-RPC endpoint
  routerA2A.get(`/.well-known/agent.json`, (_, res) =>
    res.json(BookshopAgentCard),
  );
  routerA2A.use(
    "/",
    jsonRpcHandler({
      requestHandler: new DefaultRequestHandler(
        BookshopAgentCard,
        taskStore,
        agentExecutor,
      ),
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.use("/a2a", routerA2A);

  LOG.info(`A2A agent endpoint mounted:`);
  LOG.info(`  Bookshop: GET  /.well-known/agent.json`);
});
```

What's wired up here:

- **`cds.on("bootstrap", ...)`** — CAP hands us the Express app *after* its own middlewares (auth, routing, etc.) are in place, so the A2A endpoints get CAP's request context.
- **`routerA2A.use(cds.middlewares.before)`** — ensures CDS populates request context before the A2A handler runs (needed by `cds.context` inside the executor).
- **`InMemoryTaskStore`** — stores task state in memory so clients can poll `tasks/get`. Like the checkpointer, swap for a durable store in production.
- **`DefaultRequestHandler`** — the SDK's protocol engine. It takes the Agent Card, the task store, and your executor, and implements all the JSON-RPC operations (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, …).
- **`jsonRpcHandler`** — the Express middleware exposing that handler over JSON-RPC. `UserBuilder.noAuthentication` disables auth for this session (production would plug in IAS/OAuth validation).
- **Two endpoints:** the Agent Card at `/a2a/.well-known/agent.json` (the A2A-standard well-known location, relative to the agent's root `/a2a` — CAP's root stays `/`) and the JSON-RPC API mounted under `/a2a`.

---

## Step 7 — Test the A2A agent

Start the server:

```bash
cds watch
```

### 1. Fetch the Agent Card

```bash
curl http://localhost:4004/a2a/.well-known/agent.json
```

You should see the JSON card from Step 3, with `url` set to `http://localhost:4004/a2a`.

### 2. Send a message (JSON-RPC)

```bash
curl -X POST http://localhost:4004/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "messageId": "1",
        "role": "user",
        "parts": [{ "kind": "text", "text": "Which books are cheaper than 15?" }]
      }
    }
  }'
```

The agent should answer — and because of the checkpointer, the same `contextId` in a follow-up message resumes that conversation.

### 3. Try a tool-driven prompt

```bash
curl -X POST http://localhost:4004/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "message/send",
    "params": {
      "message": {
        "messageId": "2",
        "role": "user",
        "parts": [{ "kind": "text", "text": "Update the stock of the book '\''A Wizard of Earthsea'\'' and increment by 5 units" }]
      }
    }
  }'
```

Watch the CDS log output — you should see the `a2a-agent` logger trace the execution, and the agent use its `update_stock` tool from Day 6.

---

## Summary

You now run the Day-6 agent as a standard **A2A server**:

| Piece            | File                              | Role                                                  |
| ---------------- | --------------------------------- | ----------------------------------------------------- |
| Dependency       | `package.json`                    | `@a2a-js/sdk` implements the A2A v0.3 protocol        |
| Memory           | `srv/agents/bookshop-agent.js` | `MemorySaver` checkpointer → multi-turn resumption    |
| Self-description | `srv/agents/bookshop-agent.js` | exported `AgentCard`                                  |
| Event factories  | `srv/a2a/a2a-utils.js`            | builds A2A task/status/message/artifact events        |
| Adapter          | `srv/a2a/a2a-executor.js`         | `AgentExecutor` bridging LangGraph state → A2A events |
| Mounting         | `srv/server.js`                   | Agent Card + JSON-RPC endpoints on the CAP server     |

Any A2A-compliant client — SAP Joule, Copilot, or another agent — can now discover your agent via its Agent Card and interact with it over a standard protocol. Next steps: replace `MemorySaver`/`InMemoryTaskStore` with durable stores, enable authentication via IAS, and try the streaming `message/stream` method.
