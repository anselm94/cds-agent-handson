# Day 11: Refactoring Your Agent — Skills & Middleware

On Day 10 your bookshop agent learned its second skill: it discovers S/4HANA tools over MCP at startup. But look at `agent/srv/agents/bookshop-agent.js` — one file now mixes five concerns: model configuration, hand-written tools, MCP discovery, the agent factory, and the A2A agent card. Every new capability makes the file grow, and the system prompt is where domain knowledge would pile up next.

Today you fix both problems:

1. **Refactor** the monolith into a package folder `agents/bookshop-agent/` with one module per concern (`tools`, `middlewares`, `skills`, `agent`).
2. **Teach the agent skills** — instead of stuffing all business rules into the system prompt, the prompt carries only a *menu* of skills, and a `load_skill` tool lets the agent pull detailed instructions on demand. This pattern is called **progressive disclosure**.
3. **Keep conversations short** — a summarization middleware compresses old messages automatically once the conversation crosses a token threshold.

Both new behaviors are implemented as **LangChain middleware** — hooks that run around every model call, able to rewrite what the model sees.

> **What is middleware?** LangChain v1 lets you plug hooks into the agent loop. A middleware can register extra tools, wrap every tool call, or — like we do today — wrap every *model* call (`wrapModelCall`) and rewrite the request (e.g. patch the system prompt) right before the LLM sees it.

---

# Part 1 — Split the monolith into a package folder

The refactoring itself changes no behavior: same tools, same factory, same call sites. Only the file layout changes. Verify that with a smoke test before touching any logic.

## Step 1 — Create the tools module

Create the folder and move everything tool-related out of `bookshop-agent.js`:

```bash
mkdir agent/srv/agents/bookshop-agent
```

Create `agent/srv/agents/bookshop-agent/tools.js`. Move three blocks verbatim from `bookshop-agent.js`: `getBooksTool`, `updateStockTool`, and `getMcpTools` (Days 6 and 10). Two things change: the relative import gains a segment (the file sits one level deeper), and the module exports an async `getTools()` wrapper instead of exposing internals:

```javascript
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import cds from "@sap/cds";
import { tool } from "langchain";
import { z } from "zod";
import {
  resolveDestinationHeaders,
  resolveDestinationUrl,
} from "../../mcp/utils.js";

// ... move getBooksTool, updateStockTool and getMcpTools here unchanged ...

export const getTools = async () => {
  const mcpTools = await getMcpTools();

  return [getBooksTool, updateStockTool, ...mcpTools];
};
```

Nothing else is exported — callers now ask for "the tools", not for individual tool factories.

---

## Step 2 — Slim down agent.js

Create `agent/srv/agents/bookshop-agent/agent.js`. It keeps the model, the checkpointer, the factory — and the A2A agent card, because the card describes the agent as a whole:

```javascript
import { MemorySaver } from "@langchain/langgraph";
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { createAgent } from "langchain";
import { getA2aServerUrl } from "../../a2a/a2a-utils.js";
import { getTools } from "./tools.js";

const checkpointer = new MemorySaver();

const model = new OrchestrationClient({
  promptTemplating: {
    model: {
      name: "gpt-5.4",
    },
  },
});

export const getAgent = async () => {
  return createAgent({
    model: model,
    systemPrompt:
      "You are a helpful assistant. You have 2 distinct roles: 1) You can provide information about books and update stock in the bookshop. 2) You can retrieve sales orders in the SAP S/4HANA system.",
    tools: await getTools(),
    checkpointer: checkpointer,
  });
};

// ... AgentCard moved here unchanged ...
```

Cut the complete `AgentCard` constant from `bookshop-agent.js` and paste it below `getAgent` — no edits needed.

Delete the now-empty `agent/srv/agents/bookshop-agent.js`.

> **Why a folder and not two flat files?** `agents/bookshop-agent/` groups everything that belongs to *this one agent*. When you add a second agent later, each gets its own folder with the same internal shape — a convention beats a naming scheme.

---

## Step 3 — Update the call sites

Two files imported the deleted module. Point them at the new location.

**`agent/srv/agent-service.js`**:

```diff
-import { getAgent } from "./agents/bookshop-agent.js"
+import { getAgent } from "./agents/bookshop-agent/agent.js"
```

**`agent/srv/server.js`**:

```diff
 import {
   getAgent,
   AgentCard as BookshopAgentCard,
-} from "./agents/bookshop-agent.js";
+} from "./agents/bookshop-agent/agent.js";
```

---

## Step 4 — Verify nothing changed

Start both apps as on Day 10 and re-run one bookshop prompt plus one sales-order prompt against the REST endpoint. Same answers as yesterday means the refactor is safe — commit this state mentally before continuing. The rest of the day builds features *on top* of the clean layout.

---

# Part 2 — Teach the agent skills

Your agent already answers sales-order questions, but only because the MCP `describe`/`query` tools happen to be self-explanatory. Real domain knowledge — *"never guess a book ID"*, *"CQL expands are written without a colon"*, *"report amounts with their currency"* — would traditionally land in the system prompt. That scales badly:

- The prompt is paid on **every** model call, even when the conversation never touches that domain.
- A kitchen-sink prompt dilutes attention: rules for sales orders distract from bookshop requests.

Instead, ship knowledge as **skills**: named bundles of instructions. The system prompt carries only the menu (name + description, a few dozen tokens); a `load_skill` tool fetches the full content of one skill into the conversation *when the agent decides it needs it*. Expensive knowledge is paid only when used.

## Step 5 — Define the skills catalog

Create `agent/srv/agents/bookshop-agent/skills.js`:

```javascript
import { context } from "langchain";

export const SKILLS = [
  {
    name: "manage_bookshop",
    description:
      "Business logic for managing a bookshop such as retrieving book information and updating stock.",
    content: context`
    # Bookshop Management

    ## Data Model

    Entity Books (served by BookshopService):
    - ID: Integer (primary key)
    - title: String(100)
    - author: Association to Authors
    - stock: Integer
    - price: Decimal(10,2)

    ## Tools

    ### get_books
    Retrieves books from the bookshop.
    - minPrice (optional number): only books with price >= minPrice are returned
    - maxPrice (optional number): only books with price <= maxPrice are returned
    - Both parameters may be combined to query a price range.
    - Returns a JSON array of books including ID, title, author, stock and price.

    ### update_stock
    Changes the stock of one book by an increment.
    - bookId (number): ID of the book to update
    - increment (number): positive value increases stock, negative value decreases it
    - Returns the new absolute stock value after the update.
    - Fails with 404 if no book with the given ID exists.

    ## Business Logic

    1. Never guess a book ID. If the user refers to a book by name or title,
       call get_books first and resolve the ID from its result.
    2. Check the current stock before decrementing it. Do not reduce stock below
       zero - if the requested decrement exceeds the current stock, inform the
       user instead of executing the update.
    3. After updating stock, always report the resulting new stock value to the user.
    4. For price-related questions, use the minPrice/maxPrice filters of get_books
       instead of retrieving all books and filtering manually.

    ## Examples

    - "List all books" -> get_books with no arguments
    - "Books cheaper than 20" -> get_books({ maxPrice: 20 })
    - "Increase stock of 'Beloved' by 5" ->
        1. get_books() to resolve 'Beloved' to ID 5
        2. update_stock({ bookId: 5, increment: 5 })

    `,
  },
  {
    name: "manage_salesorders",
    description:
      "Schema and business logic for retrieving sales orders from the SAP S/4HANA system.",
    content: context`
    # Schema

    Access sales order data exclusively through the 'salesorder-mcp' MCP tools:
    - describe: returns the data model (entities, keys, elements, associations).
      Call this first whenever you are unsure which entities or fields exist -
      do not guess field names.
    - query: executes CAP CQL statements against the service. Only SELECT
      statements are allowed; the service is strictly read-only.

    ## Tables

    ### SalesOrders (header level)
    - SalesOrder: String(10), primary key (e.g. "1001")
    - SalesOrderType: String(4), e.g. OR = standard order
    - SalesOrganization / DistributionChannel / OrganizationDivision: org split
    - SoldToParty: String(10), customer number of the sold-to party
    - ShippingType
    - CreationDate: Date; CreatedByUser: String(12)
    - TotalNetAmount: Decimal(16,3), net value of the whole order
    - TransactionCurrency: currency key of all amount fields
    - PurchaseOrderByCustomer: customer reference / PO number
    - PaymentMethod
    - OverallSDProcessStatus: String(1) overall process status
    - to_Item: association (1-*) to SalesOrderItems

    ### SalesOrderItems (item/position level)
    Composite primary key: SalesOrder + SalesOrderItem
    - SalesOrderItemText
    - MaterialGroup / Material / MaterialByCustomer
    - RequestedQuantity: Decimal; RequestedQuantityUnit (e.g. PC)
    - NetAmount: Decimal(16,3), net value of the item
    - TransactionCurrency

    ## Relationships

    - One SalesOrders row has many SalesOrderItems rows (association to_Item).
    - Navigate with path expressions instead of SQL joins:
      SELECT from SalesOrders { ..., to_Item { ... } }
    - SalesOrderItems.SalesOrder is the foreign key back to the header, so items
      can also be queried directly filtered by SalesOrder.

    ## Business Logic

    1. Read-only: the query tool accepts only SELECT statements. Do not attempt
       INSERT, UPDATE, DELETE or DDL.
    2. Nested expands are written WITHOUT a colon before the brace:
       correct:   to_Item { SalesOrderItem, NetAmount }
       incorrect: to_Item: { SalesOrderItem, NetAmount }  (fails to compile)
    3. Amount fields are returned as strings ("2500.000"). Always report amounts
       together with their TransactionCurrency.
    4. OverallSDProcessStatus values: A = Open, B = In Process, C = Completed.
    5. Results are capped at roughly 1000 rows per query. Prefer precise filters
       over broad scans.
    6. Aggregated columns (sum/count in projections with GROUP BY) may not be
       returned reliably by this tool - only the group-by keys come back.
       For totals, fetch the rows and sum them up yourself.
    7. For item-level questions either expand to_Item on the header or query
       SalesOrderItems directly with a filter on SalesOrder.

    ## Example Query

    Header list:
    SELECT from SalesOrders { SalesOrder, SalesOrderType, CreationDate, TotalNetAmount, TransactionCurrency, OverallSDProcessStatus }

    Order incl. its items:
    SELECT from SalesOrders { SalesOrder, TotalNetAmount, TransactionCurrency, to_Item { SalesOrderItem, SalesOrderItemText, Material, RequestedQuantity, RequestedQuantityUnit, NetAmount } }

    Open orders only:
    SELECT from SalesOrders WHERE OverallSDProcessStatus = 'A'

    All items of one order:
    SELECT from SalesOrderItems WHERE SalesOrder = '1001'

    Orders created in August 2026:
    SELECT from SalesOrders WHERE CreationDate >= '2026-08-01' AND CreationDate <= '2026-08-31'`,
  },
];
```

Two details worth noting:

- Each skill is a plain object: `name` (the lookup key), `description` (what the agent reads in the menu to decide relevance), and `content` (what gets loaded on demand).
- The **`context`** template tag comes from LangChain. Multi-line strings inside code pick up the surrounding indentation — `context` strips the common leading whitespace and trims the ends, so what the agent receives starts at column zero while your source stays readable.

> Notice what the catalog encodes: hard-won lessons from Days 9–10 debugging sessions (expand syntax, string-typed decimals, aggregate quirks) became *reusable agent knowledge*, not tribal memory.

---

## Step 6 — Add the `load_skill` tool

Skills are useless if the agent cannot fetch them. Append a generic loader tool to `agent/srv/agents/bookshop-agent/tools.js`:

```diff
 import {
   resolveDestinationHeaders,
   resolveDestinationUrl,
 } from "../../mcp/utils.js";
+import { SKILLS } from "./skills.js";
```

```javascript
export const loadSkill = tool(
  async ({ skillName }) => {
    // Find and return the requested skill
    const skill = SKILLS.find((s) => s.name === skillName);
    if (skill) {
      return `Loaded skill: ${skillName}\n\n${skill.content}`;
    }

    // Skill not found
    const available = SKILLS.map((s) => s.name).join(", ");
    return `Skill '${skillName}' not found. Available skills: ${available}`;
  },
  {
    name: "load_skill",
    description: `Load the full content of a skill into the agent's context.

Use this when you need detailed information about how to handle a specific
type of request. This will provide you with comprehensive instructions,
policies, and guidelines for the skill area.`,
    schema: z.object({
      skillName: z.string().describe("The name of the skill to load"),
    }),
  },
);
```

The tool is intentionally generic — it knows nothing about bookshops or sales orders. Adding a third skill tomorrow means editing `skills.js` only; the loader keeps working.

Note the graceful miss case: asking for an unknown skill returns the list of valid names, giving the agent a chance to self-correct instead of failing.

---

## Step 7 — Surface the skill menu via middleware

One piece is missing: the agent must *know the menu exists*. Create `agent/srv/agents/bookshop-agent/middlewares.js`:

```javascript
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { createMiddleware, summarizationMiddleware } from "langchain";
import { SKILLS } from "./skills.js";
import { loadSkill } from "./tools.js";

const model = new OrchestrationClient({
  promptTemplating: {
    model: {
      name: "gpt-5.4",
    },
  },
});

// Build skills prompt from the SKILLS list
const skillsPrompt = SKILLS.map(
  (skill) => `- **${skill.name}**: ${skill.description}`,
).join("\n");

const skillMw = createMiddleware({
  name: "skillMiddleware",
  tools: [loadSkill],
  wrapModelCall: async (request, handler) => {
    // Build the skills addendum
    const skillsAddendum =
      `\n\n## Available Skills\n\n${skillsPrompt}\n\n` +
      "Use the load_skill tool when you need detailed information " +
      "about handling a specific type of request.";

    // Append to system prompt
    const newSystemMessage = request.systemMessage.concat(skillsAddendum);

    return handler({
      ...request,
      systemMessage: newSystemMessage,
    });
  },
});
```

And register the middleware in the factory in `agent.js`:

```diff
 import { getA2aServerUrl } from "../../a2a/a2a-utils.js";
+import { getMiddlewares } from "./middlewares.js";
 import { getTools } from "./tools.js";
```

```diff
     tools: await getTools(),
     checkpointer: checkpointer,
+    middleware: await getMiddlewares(),
   });
 };
```

Finally, close `middlewares.js` with the exporter `agent.js` calls (for now with a single middleware — Part 3 adds the second):

```javascript
export const getMiddlewares = async () => {
  return [skillMw];
};
```

How `skillMw` works, piece by piece:

- **`tools: [loadSkill]`** — middlewares can bring their own tools. Declaring the loader here (instead of in `getTools()`) keeps the whole skills feature in one place: remove the middleware and its tool, and the agent is back to its Day-10 state.
- **`wrapModelCall`** — wraps *every* model invocation. Before each call, the skills menu is appended to the system prompt; the model never sees a turn without the menu, yet the menu costs a handful of tokens.
- **`request.systemMessage.concat(...)`** — messages are immutable; `concat` returns a *new* system message with the addendum attached.
- **`handler({ ...request, systemMessage })`** — passes the rewritten request down the (possibly longer) middleware chain and eventually to the model. Forgetting to call `handler` or dropping properties breaks the pipeline — always spread the original request.

---

# Part 3 — Keep conversations short: summarization middleware

Day 7 gave the agent a checkpointer, so conversations persist across messages. Persistence has a cost: every turn resends the full history, and long sessions eventually blow the model's context window — or quietly burn money on repeated tokens.

LangChain ships a ready-made middleware for exactly this.

## Step 8 — Add the summarization middleware

Add it to `middlewares.js` right below `skillMw`:

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

```diff
 export const getMiddlewares = async () => {
-  return [skillMw];
+  return [skillMw, summarizationMw];
 };
```

Configuration walkthrough:

- **`trigger.tokens: 4000`** — once the conversation's token count crosses 4000, the middleware kicks in. Below that, nothing happens — short chats pay zero overhead.
- **`keep.messages: 10`** — when triggered, the most recent 10 messages stay verbatim; everything older is replaced by a single AI-generated summary message.
- **`model`** — the summarizer needs its own LLM to write those summaries. This reuses the same `OrchestrationClient` defined at the top of `middlewares.js` — a deliberate separation from the agent's main model in `agent.js`: you could downgrade the summarizer to a cheaper model without touching the agent.

> **Why a second `OrchestrationClient` instance at all?** It documents intent: this model serves *infrastructure* (summarization), not the conversation. Swapping or tuning it is a one-line change with no blast radius on agent behavior.

Order matters mildly: `skillMw` first ensures the menu is present in every model call, including calls made *after* summarization compressed history.

---

# Part 4 — Test end-to-end

## Step 9 — Print the conversation trace

To *see* skills being loaded, add a temporary trace of the final conversation to the A2A executor. In `agent/srv/a2a/a2a-executor.js`, after `this.#agent.invoke(...)` returns and before the interrupt check:

```diff
       }
 
+      // Print the conversation for debugging - to know skills, tools being invoked
+      for (const message of res.messages) {
+        console.log(`${message._getType()}: ${message.content}`);
+      }
+
       if (isInterrupted(res)) {
```

Every message of the finished run — system, human, AI, tool — is printed with its type. This is your window into middleware and tool behavior: you will see the skills menu in the system message, `load_skill` tool calls, and the fetched skill content flowing back as a `ToolMessage`.

---

## Step 10 — Run mixed prompts and watch skills load

Start both apps in two terminals:

```bash
# Terminal 1 — the MCP server on :4005
cd mcp && npm run watch

# Terminal 2 — the agent on :4004
cd agent && cds watch
```

Then send prompts through the A2A endpoint so the trace from Step 8 shows (the REST `/invoke` path logs only the final answer):

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
        "parts": [{ "kind": "text", "text": "Increase stock of the book '\''Beloved'\'' by 5" }]
      }
    }
  }'
```

Expected sequence in Terminal 2:

1. `system:` — the base prompt ending with the **Available Skills** menu injected by `skillMw`.
2. `human:` — your question.
3. `ai:` — a `load_skill` call for `manage_bookshop`. The *"never guess a book ID"* rule forces the agent to learn how to resolve `'Beloved'` to an ID before touching stock.
4. `tool:` — `Loaded skill: manage_bookshop` followed by the full markdown content.
5. `ai:` — a `get_books` call resolving the title, then `update_stock`.
6. `ai:` — the final answer reporting the new stock value.

Now the second domain — the agent should reach for a different skill:

```json
{ "text": "Show me the top 5 sales orders including their items" }
```

Watch for a `load_skill` call with `manage_salesorders`, and the subsequent MCP `query` call using correct CQL expand syntax (`to_Item { ... }`) — the skill taught it the syntax without the system prompt ever containing it.

Finally, confirm a trivial prompt stays cheap:

```json
{ "text": "Hi, who are you?" }
```

No skill loads, no MCP call — the agent answers straight from the slim prompt. Progressive disclosure means unused knowledge costs nothing.

> **Summarization check (optional):** hold one conversation open (reuse the same `contextId` via follow-up `message/send` requests) and chat past ~15 exchanges. Once history crosses 4000 tokens, the trace shows the older turns collapsed into a single summary message while the last 10 remain intact.

---

You now have an agent whose knowledge grows by *adding files*, not by editing prompts — and whose memory survives long conversations. Next days can build on the same pattern: a third skill is a data entry, a new middleware is one more file in the folder.

## References

- [LangChain v1 — Middleware](https://docs.langchain.com/oss/javascript/langchain/middleware)
- [LangChain v1 — Summarization middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in#summarization)
- [`langchain` on npm](https://www.npmjs.com/package/langchain)
- [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Day 10: Connecting Your Agent to the MCP Server](./day-10.md)
