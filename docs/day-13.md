# Day 13: Short-Term and Long-Term Memory in LangChain

On Day 13, the agent learns two different memory patterns:

1. **Short-term memory** with a LangChain **checkpointer**
2. **Long-term memory** with a LangChain **store**

Use this rule of thumb:

- **Short-term memory** remembers the current conversation
- **Long-term memory** remembers the user across conversations

In this codebase:

- `MemorySaver` handles short-term memory
- `InMemoryStore` handles long-term memory
- `thread_id` identifies the conversation thread
- `userId` identifies whose long-term memory to read and write

---

# Part 1 - Short-term memory

Short-term memory means: the agent remembers what happened earlier in the same conversation.

Examples:

- "List books cheaper than 30"
- "Only show the first two"
- "Approve it"

Those follow-up prompts only work if the agent can resume the same thread.

## 1.1 Add a checkpointer

In `agent/srv/agents/bookshop-agent/agent.js`:

```javascript
import { MemorySaver } from "@langchain/langgraph";

const checkpointer = new MemorySaver(); // short-term memory
```

And register it in the agent:

```javascript
return createAgent({
  model: model,
  systemPrompt: context`...`,
  tools: await getTools(),
  middleware: await getMiddlewares(),
  checkpointer: checkpointer,
  store: store,
});
```

What the checkpointer does:

- saves graph state for one thread
- allows follow-up questions
- supports interrupt/resume flows

## 1.2 Pass a stable `thread_id`

The checkpointer only works if each conversation uses the same thread key.

### REST path

In `agent/srv/agent-service.js`:

```javascript
const agentInputs = {
  messages: [{ role: "user", content: message }],
  userId: cds.context?.user?.id,
  tenantId: cds.context?.tenant,
};

const result = await bookshopAgent.invoke(agentInputs, {
  configurable: {
    thread_id: cds.context?.id,
  },
});
```

### A2A path

In `agent/srv/a2a/a2a-executor.js`:

```javascript
const config = {
  configurable: {
    thread_id: contextId,
  },
};
```

And for new messages:

```javascript
res = await this.#agent.invoke(
  {
    messages: [{ role: "user", content: messageText }],
    userId: cds.context?.user?.id,
    tenantId: cds.context?.tenant,
  },
  config,
);
```

Remember:

- `thread_id` scopes short-term memory
- if the thread changes, the memory changes

## 1.3 Expose thread state to tools

In `agent/srv/agents/bookshop-agent/middlewares.js`:

```javascript
import { z } from "zod";
import { StateSchema } from "@langchain/langgraph";

// ... other middlewares ...

const UserState = new StateSchema({
  userId: z.string(),
  tenantId: z.string().optional(),
});

const stateExtMw = createMiddleware({
  name: "StateExtension",
  stateSchema: UserState,
});
```

Registered as:

```javascript
return [skillMw, summarizationMw, stateExtMw];
```

This lets tools read:

- `config.state.userId`
- `config.state.tenantId`

## 1.4 `get-user-info` is a short-term memory example

In `agent/srv/agents/bookshop-agent/tools.js`:

```javascript
const getUserInfo = tool(
  async (_, config) => {
    const userId = config.state.userId;
    const tenantId = config.state.tenantId;
    return `{"userId": "${userId}", "tenantId": "${tenantId}"}`;
  },
  {
    name: "get-user-info",
    description: "Get user info",
    schema: z.object({}),
  },
);

export const getTools = async () => {
  const mcpTools = await getMcpTools();

  return [getBooksTool, updateStockTool, queryKBTool, getUserInfo, ...mcpTools];
};
```

Why this is **short-term** memory:

- it reads from `config.state`
- that state is attached to the current thread/run
- it does **not** read from `config.store`

So `get-user-info` demonstrates: **state from the current conversation is available inside tools**.

## 1.5 Summarization still matters

The summarization middleware is still configured in `middlewares.js`:

```javascript
const summarizationMw = summarizationMiddleware({
  model: model,
  trigger: {
    tokens: 4000,
  },
  keep: {
    messages: 10,
  },
});
```

Why keep it:

- the checkpointer preserves the thread
- summarization stops the thread from growing forever

Short version:

1. `MemorySaver` keeps the conversation
2. summarization keeps it small

---

# Part 2 - Long-term memory

Long-term memory means: the agent remembers durable facts about the user.

In Day 13, that durable fact is **user preferences**.

Examples:

- "I prefer concise answers"
- "Always answer in bullet points"
- "Use a friendly tone"

These should survive beyond one prompt and be reusable later for the same user.

## 2.1 Add a store

In `agent/srv/agents/bookshop-agent/agent.js`:

```javascript
import { InMemoryStore } from "@langchain/langgraph";

const store = new InMemoryStore(); // long-term memory
```

And register it in `createAgent()`:

```javascript
store: store,
```

Important for trainees:

- this is still in-memory
- restarting the app clears it
- that is fine for learning the concept

## 2.2 Save user preferences

In `agent/srv/agents/bookshop-agent/tools.js`:

```javascript
const saveUserPreferences = tool(
  async ({ text }, config) => {
    const userId = config.state.userId;

    await config.store.put(["users", "preferences"], userId, text);

    return `Preferences for user ${userId} saved successfully.`;
  },
  {
    name: "save-user-preferences",
    description: "Save user preferences",
    schema: z.object({
      text: z.string().describe("User preferences to save"),
    }),
  },
);
```

What it stores:

- namespace: `["users", "preferences"]`
- key: `userId`
- value: the preference text

## 2.3 Read user preferences

Also in `tools.js`:

```javascript
const getUserPreferences = tool(
  async (_, config) => {
    const userId = config.state.userId;

    const preferences = await config.store.get(
      ["users", "preferences"],
      userId,
    );

    if (preferences) {
      return `Preferences for user ${userId}: ${preferences.value}`;
    } else {
      return `No preferences found for user ${userId}.`;
    }
  },
  {
    name: "get-user-preferences",
    description: "Get user preferences",
    schema: z.object({}),
  },
);
```

Why this is **long-term** memory:

- it reads from `config.store`
- the memory is keyed by `userId`
- it is meant to be reused across conversations for the same user

---

# Part 3 - Teach the agent to use memory

The tools alone are not enough. The prompt must tell the agent when to use them.

In `agent/srv/agents/bookshop-agent/agent.js` the prompt now includes:

```javascript
systemPrompt: context`You are a helpful assistant. 
    
    For every request, you must read user preferences to tailor your responses. If the user has preferences, save the preferences. 
      
    You have 3 distinct roles: 
      1) You can provide information about books and update stock in the bookshop. 
      2) You can retrieve sales orders in the SAP S/4HANA system. 
      3) You can query the Knowledge Base for SAP's AI Practical Use Cases.`,
```

What this tells the model:

- read preferences before answering
- tailor the answer to that user
- save new preferences when the user shares them

Practical note:

- the current code says `If the user has preferences, save the preferences.`
- the intended meaning is closer to: save preferences when the user shares them

---

# Part 4 - Quick mental model

Use this table when explaining Day 13:

| Concept                   | LangChain feature | Key                | Example             |
| ------------------------- | ----------------- | ------------------ | ------------------- |
| Short-term memory         | `checkpointer`    | `thread_id`        | follow-up questions |
| Short-term state in tools | `config.state`    | current run/thread | `get-user-info`     |
| Long-term memory          | `store`           | `userId`           | user preferences    |

---

# Part 5 - Demo flow

## Demo 1 - Short-term memory

Send these prompts in the same thread:

```json
{ "message": "List the books cheaper than 30" }
```

```json
{ "message": "Only show the first two" }
```

Expected result:

- the second prompt depends on the first
- the agent can continue because the thread is remembered

## Demo 2 - A2A resume flow

Use a flow that interrupts and then resume it with the same `contextId`.

Expected result:

- the agent resumes from the existing thread state

## Demo 3 - Save a preference

Send:

```json
{ "message": "I prefer concise bullet-point answers." }
```

Expected result:

- the agent stores that preference for the current `userId`

## Demo 4 - Reuse the preference

Later, ask:

```json
{ "message": "What are some SAP AI use cases in finance?" }
```

Expected result:

- the agent reads the stored preference
- the answer comes back in a concise bullet-point style

## Demo 5 - Different user, different memory

Repeat the preference flow as another authenticated user.

Expected result:

- user B should not inherit user A's preferences

## References

- [LangChain v1 Memory Overview](https://docs.langchain.com/oss/javascript/langchain/short-term-memory)
- [LangGraph Checkpointers](https://langchain-ai.github.io/langgraphjs/concepts/persistence/)
- [LangGraph Memory Store](https://langchain-ai.github.io/langgraphjs/concepts/memory/)
- [Day 11: Refactoring Your Agent — Skills & Middleware](./day-11.md)
- [Day 12: Give Your Agent a Knowledge Base with RAG](./day-12.md)
