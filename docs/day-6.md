# Day 6: Giving Your Agent Tools — Function Calling with CAP Services

In this hands-on session, you will extend the agent built on Day 4 with **tools** — functions the agent can call to act on real data. You will add a CAP bookshop service, then give the agent two tools: one to read books and one to update their stock, allowing it to fulfill requests like *"update the stock of a book"* on its own.

---

## Step 1 — Define the data model

Create the file `db/schema.cds`. This defines the domain model for your bookshop with two entities: `Books` (with a `stock` and `price`) and `Authors`.

```cds
namespace my.bookshop;

entity Books {
    key ID     : Integer;
        title  : String(100);
        author : Association to Authors;
        stock  : Integer;
        price  : Decimal(10, 2);
}

entity Authors {
    key ID   : Integer;
        name : String(100);
}
```

---

## Step 2 — Add sample data

Seed the database with CSV files so the agent has data to work with. CAP automatically loads files in `db/data/` named after their fully-qualified entity name.

**`db/data/my.bookshop-Books.csv`**

```csv
ID,title,author_ID,stock,price
1,Foundation,1,12,19.99
2,A Wizard of Earthsea,2,8,14.50
3,Kindred,3,15,17.95
4,2001: A Space Odyssey,4,10,16.25
5,Beloved,5,6,18.75
```

**`db/data/my.bookshop-Authors.csv`**

```csv
ID,name
1,Isaac Asimov
2,Ursula K. Le Guin
3,Octavia E. Butler
4,Arthur C. Clarke
5,Toni Morrison
```

---

## Step 3 — Expose the bookshop as a CAP service

Create the file `srv/bookshop-service.cds`. This service exposes the `Books` and `Authors` entities and declares an `updateStock` action that the agent will later call.

```cds
using {my.bookshop as b} from '../db/schema';

service BookshopService {
    entity Books   as projection on b.Books
        actions {
            action updateStock(increment: Integer) returns Integer;
        };

    entity Authors as projection on b.Authors;
}
```

---

## Step 4 — Implement the service handler

Create the file `srv/bookshop-service.js`. The handler looks up the book by `ID`, rejects with a `404` if it does not exist, then adjusts the stock and returns the new value.

```javascript
import cds from "@sap/cds";

export class BookshopService extends cds.ApplicationService {
  init() {
    const { Books, Authors } = cds.entities("BookshopService");

    this.on("updateStock", Books, async (req) => {
      const { ID } = req.params[0];
      const { increment } = req.data;

      const book = await SELECT.one.from(Books).where({ ID: ID });

      if (!book) {
        req.reject(404, `Book with ID ${ID} not found`);
      }

      const newStock = book.stock + increment;

      await UPDATE(Books).set({ stock: newStock }).where({ ID });

      return newStock;
    });

    return super.init();
  }
}
```

---

## Step 5 — Define the agent's tools

Open `srv/agents/hello-world-agent.js` and rewrite it to give the agent two tools. Each tool is created with `tool()` from LangChain and has two aspects:

- **Design-time aspect** — `name`, `description`, and a `zod` `schema` that describes the arguments. The model uses this to decide when and how to call the tool.
- **Runtime aspect** — the async function that actually executes when the tool is invoked.

Both tools connect to the CAP service via `cds.connect.to("BookshopService")` and run their queries through it.

```javascript
import { createAgent } from "langchain";
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { tool } from "langchain";
import cds from "@sap/cds";
import { z } from "zod";

const model = new OrchestrationClient({
  promptTemplating: {
    model: {
      name: "gpt-5.4",
    },
  },
});

const getBooksTool = tool(
  // runtime aspect
  async ({ minPrice, maxPrice }) => {
    const srv = await cds.connect.to("BookshopService");

    const query = SELECT.from("Books");

    if (minPrice !== undefined) {
      query.where("price", ">=", minPrice);
    }

    if (maxPrice !== undefined) {
      query.where("price", "<=", maxPrice);
    }

    const res = await srv.run(query);

    return JSON.stringify(res);
  },

  // design time aspect
  {
    name: "get_books",
    description: "Gets the list of books",
    schema: z.object({
      minPrice: z.number().describe("Minimum price to filter").optional(),
      maxPrice: z.number().describe("Maximum price to filter").optional(),
    }),
  },
);

const updateStockTool = tool(
  // runtime aspect
  async ({ bookId, increment }) => {
    const srv = await cds.connect.to("BookshopService");

    const res = await srv.send({
      event: "updateStock",
      entity: "Books",
      data: { increment },
      params: [{ ID: bookId }],
    });

    return JSON.stringify(res);
  },

  // design time aspect
  {
    name: "update_stock",
    description: "Updates the stock of a book",
    schema: z.object({
      bookId: z.number().describe("ID of the book to update"),
      increment: z
        .number()
        .describe("Amount to increment/decrement the stock by"),
    }),
  },
);

export const helloAgent = createAgent({
  model: model,
  systemPrompt: "You are a helpful SAP assistant.",
  tools: [getBooksTool, updateStockTool],
});
```

---

## Step 6 — Register the tools on the agent

In the same file, the agent is configured with the two tools via the `tools` option of `createAgent`:

```javascript
export const helloAgent = createAgent({
  model: model,
  systemPrompt: "You are a helpful SAP assistant.",
  tools: [getBooksTool, updateStockTool],
});
```

With the tools registered, the model can now decide during a conversation whether to answer directly or call `get_books` / `update_stock` to act on the bookshop data.

---

## Step 7 — Read the agent's final answer

Open `srv/agent-service.js`. The agent conversation is no longer a simple two-message exchange — calling a tool appends extra messages to the result. The final answer is therefore always the **last** message, not a hardcoded index:

```javascript
const result = await helloAgent.invoke(agentInputs);

console.log(result.messages[result.messages.length - 1].content);

return req.reply(result.messages[result.messages.length - 1].content);
```

> Previously the code used `result.messages[1]`. Once the agent uses tools, the conversation grows, so always take the last message to get the actual response.

---

## Step 8 — Test the agent with a tool

Update the message in [`test/http/AgentService.http`](../test/http/AgentService.http) to a prompt that requires a tool call:

```json
{
  "message": "Update the stock of the book - 'A Wizard of Earthsea' and increment by 5 units"
}
```

Start the server and invoke the `AgentService`:

```bash
cds watch
```

Then run the request in `AgentService.http`. The agent should:
1. Identify that updating stock requires the `update_stock` tool.
2. Call the tool with the book ID (2) and increment (5).
3. Return the new stock value for *A Wizard of Earthsea*.

You can also try a read-only prompt such as *"Which books are cheaper than 15?"* to see the `get_books` tool in action.