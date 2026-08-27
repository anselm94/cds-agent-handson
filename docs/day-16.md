# Day 16: In-Context Price Prediction with SAP RPT

Day 15 split the monolith into three agents; Part 2 added content filtering and data privacy on the orchestrator. Day 16 adds **machine-learning prediction** to the Bookshop Agent: a new `predict_book_price` tool that uses SAP's **Relational Pretrained Transformer** (`sap-rpt-1`) to guess a book's price from historical data — without ever training a model.

Everything stays inside the three-agent architecture; only four files change:

| Change                               | File                          | Why                                                    |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------ |
| Add `@sap-ai-sdk/rpt` package        | `agent/package.json`          | Client for SAP RPT (foundation model for tabular data) |
| Add `predict_book_price` tool        | `bookshop-agent/tools.js`     | In-context price prediction                            |
| Update bookshop prompt               | `bookshop-agent/agent.js`     | Tell the agent it can predict prices                   |
| Update orchestrator prompt + masking | `orchestrator-agent/agent.js` | Route price questions; stop masking author names       |

---

## Step 1 - Add the `@sap-ai-sdk/rpt` dependency

Add the RPT package:

```bash
npm install @sap-ai-sdk/rpt
```

---

## Step 2 - Add the `predict_book_price` tool

In `bookshop-agent/tools.js`, import `RptClient` and instantiate a client:

```javascript
import { RptClient } from "@sap-ai-sdk/rpt";

const rptClient = new RptClient("sap-rpt-1-small");
```

Then add the tool. It reads a few existing books as **context rows**, appends the book to predict as a **query row** (with `price: "[PREDICT]"`), and asks RPT to fill the gap:

```javascript
const predictBookPriceTool = tool(
  // runtime aspect
  async ({ title, author_name }) => {
    const srv = await cds.connect.to("BookshopService");

    const query = SELECT.from("Books")
      .columns("ID", "title", "price", "author.name")
      .limit(5);
    const res = await srv.run(query);

    const prediction = await rptClient.predictWithSchema(
      // Data schema
      [
        { name: "ID", dtype: "string" },
        { name: "title", dtype: "string" },
        { name: "price", dtype: "numeric" },
        { name: "author_name", dtype: "string" },
      ],
      // Prediction data
      {
        prediction_config: {
          target_columns: [
            {
              name: "price",
              prediction_placeholder: "[PREDICT]",
              task_type: "regression",
            },
          ],
        },
        index_column: "ID",
        rows: [
          ...res.map((book) => ({
            ID: book.ID,
            title: book.title,
            price: book.price,
            author_name: book["author.name"],
          })),
          {
            ID: "new",
            title: title,
            price: "[PREDICT]",
            author_name: author_name,
          },
        ],
      },
    );

    const predictedPrice = prediction.predictions[0].price[0].prediction;

    LOG.info(
      `Predicted price for book '${title}' by '${author_name}' is ${predictedPrice}`,
    );

    return `Predicted price for book '${title}' by '${author_name}' is ${predictedPrice}`;
  },

  // design time aspect
  {
    name: "predict_book_price",
    description: "Predicts the price of a book based on historical data",
    schema: z.object({
      title: z.string().describe("Title of the book"),
      author_name: z.string().describe("Name of the author"),
    }),
  },
);
```

Finally, register it in `getTools()`:

```javascript
export const getTools = async () => {
  return [getBooksTool, updateStockTool, predictBookPriceTool];
};
```

---

## Step 3 - Update the Bookshop Agent prompt

In `bookshop-agent/agent.js`, extend the system prompt so the model knows about the new capability:

```javascript
systemPrompt: context`You are a Bookshop Agent that can provide information about books, update stock and predict prices for books in the bookshop.`,
```

---

## Step 4 - Update the Orchestrator

In `orchestrator-agent/agent.js`, two small changes:

**1. Route price questions** — mention prediction in the sub-agent description:

```javascript
- Bookshop Agent: Can provide information about books, update stock and predict prices for books in the bookshop.
```

**2. Stop masking author names** — comment out `profile-person` from the DPI masking entities:

```javascript
entities: [
  // "profile-person",
  "profile-address",
  "profile-email",
  "profile-username-password",
],
```

Why: `predict_book_price` needs the **author's name** to make a meaningful guess. Since `profile-person` would anonymize author names before they reach the model, we disable it. The remaining entities (address, email, credentials) still get masked.

---

## Key concept - RPT (Relational Pretrained Transformer)

- **SAP RPT** (`sap-rpt-1`) is a foundation model for **tabular data**, exposed through `@sap-ai-sdk/rpt`. It predicts missing values in a table using *in-context learning* — no training, no fine-tuning.
- **Context rows vs. query row**: you send existing rows as examples, plus one (or more) rows with a placeholder (`[PREDICT]`) in the target column. The model infers the missing value from the surrounding rows.
- **`prediction_placeholder`** marks the cells to fill; **`task_type`** is `regression` (continuous, e.g. price) or `classification` (categorical, e.g. a group).
- Compare with the other agents' tools: `get_books`/`update_stock` *read/write* the DB and `query-promo`/sales-order tools *execute* logic. `predict_book_price` is the first **inference** tool — the answer comes from a model, not from stored data.

---

## Demo flow

Run the app and route a prediction request through the orchestrator:

```
Predict the price of the book - "Harry Potter and the Philosopher's Stone" by "J.K. Rowling"
```

Expected: the orchestrator calls `ask-bookshop-agent`, which calls `predict_book_price`, reads up to 5 books as context, and returns a predicted price.

## References

- [Day 15: Break the Monolith into 3 Agents](./day-15.md)
- [SAP AI SDK — RPT](https://sap.github.io/ai-sdk/docs/js/rpt)
- [SAP RPT-1 — Example Payloads](https://help.sap.com/docs/sap-ai-core/generative-ai/example-payloads-for-inferencing-sap-rpt-1)
