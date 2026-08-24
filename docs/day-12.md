# Day 12: Give Your Agent a Knowledge Base with RAG

On Day 11 your agent learned how to load skills on demand and keep long conversations short. It still only knows what fits into its prompt, its tools, and the live systems behind those tools. That is enough for bookshop data and S/4HANA sales orders, but not for long-form reference material such as product guides, handbooks, or internal documentation.

Today you add a third capability: a **knowledge base** backed by SAP AI SDK **Document Grounding**. The flow is simple:

1. Create a vector collection.
2. Split a markdown document into chunks and ingest it.
3. Expose retrieval as a local CAP service.
4. Add one more LangChain tool so the agent can query that knowledge base.

The agent will then have three distinct roles:

1. Manage books in the local CAP bookshop.
2. Retrieve sales orders from S/4HANA through MCP.
3. Retrieve answers from a grounded document collection.

---

# Part 1 - Install the RAG dependencies

Inside `agent/`, install the two packages required for ingestion and retrieval:

```bash
npm install @sap-ai-sdk/document-grounding

npm install @langchain/textsplitters
```

What they are used for:

- `@sap-ai-sdk/document-grounding` provides the APIs for creating vector collections, uploading document chunks, and running retrieval.
- `@langchain/textsplitters` breaks a long markdown document into smaller overlapping chunks before embedding.

After the install, `agent/package.json` gains these dependencies:

```json
{
  "dependencies": {
    "@langchain/textsplitters": "^1.0.1",
    "@sap-ai-sdk/document-grounding": "^2.15.0"
  }
}
```

---

# Part 2 - Expose RAG operations as a CAP service

Instead of letting the agent call Document Grounding directly, create a small local CAP facade. This keeps the infrastructure details in one place and lets the agent treat retrieval as just another application service.

Create `agent/srv/rag-service.cds`:

```cds
service RAGService {
    action createCollection(collectionName: String)                 returns String;

    action deleteCollection(collectionName: String);

    action ingestDocument(collectionName: String, document: String) returns String;

    action query(collectionName: String, query: String)             returns String;
}
```

The service exposes four actions:

- `createCollection`: creates a vector collection and returns its ID.
- `deleteCollection`: removes a collection by name.
- `ingestDocument`: splits and uploads one markdown document.
- `query`: retrieves the most relevant chunks for a question.

---

# Part 3 - Implement the RAG service

Create `agent/srv/rag-service.js`:

```javascript
import cds from "@sap/cds";
import { VectorApi, RetrievalApi } from "@sap-ai-sdk/document-grounding";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export class RAGService extends cds.ApplicationService {
  init() {
    const getCollectionByName = async (collectionName) => {
      const res = await VectorApi.getAllCollections().execute();

      const collection = res.resources.find(
        (collection) => collection.title === collectionName,
      );

      if (!collection) {
        throw new Error(`Collection with name ${collectionName} not found`);
      }

      return collection.id;
    };

    this.on("createCollection", async (req) => {
      const { collectionName } = req.data;

      const res = await VectorApi.createCollection(
        {
          title: collectionName,
          embeddingConfig: {
            modelName: "text-embedding-3-small",
          },
          metadata: [],
        },
        {
          "AI-Resource-Group": "default",
        },
      ).executeRaw();

      return res.headers.location?.split("/").at(-2);
    });

    this.on("deleteCollection", async (req) => {
      const { collectionName } = req.data;

      const collectionId = await getCollectionByName(collectionName);

      await VectorApi.deleteCollectionById(collectionId, {
        "AI-Resource-Group": "default",
      }).execute();
    });

    this.on("ingestDocument", async (req) => {
      const { collectionName, document } = req.data;

      const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
        chunkSize: 256,
        chunkOverlap: 64,
      });
      const texts = await splitter.splitText(document);

      const collectionId = await getCollectionByName(collectionName);

      const res = await VectorApi.createDocuments(
        collectionId,
        {
          documents: [
            {
              metadata: [],
              chunks: texts.map((text) => ({
                content: text,
                metadata: [],
              })),
            },
          ],
        },
        {
          "AI-Resource-Group": "default",
        },
      ).execute();

      return res.documents.at(-1)?.id;
    });

    this.on("query", async (req) => {
      const { collectionName, query } = req.data;

      const collectionId = await getCollectionByName(collectionName);

      const res = await RetrievalApi.search({
        query: query,
        filters: [
          {
            id: "filter-1",
            searchConfiguration: {
              maxChunkCount: 10,
            },
            dataRepositories: [collectionId],
            dataRepositoryType: "vector",
          },
        ],
      }).execute();

      const chunks = [];

      for (const document of res.results[0].results[0].dataRepository.documents) {
        for (const chunk of document.chunks) {
          chunks.push(chunk.content);
        }
      }

      return chunks.join("\n\n---\n\n");
    });

    return super.init();
  }
}
```

## Step 1 - Resolve collections by title

The helper `getCollectionByName()` calls `VectorApi.getAllCollections()` and finds the collection whose `title` matches the requested name.

Why resolve by title instead of ID?

- Humans remember names such as `collection-<identity>`.
- Document Grounding operations use collection IDs.
- This helper hides that translation from the rest of the code.

If the collection does not exist, it throws an error immediately instead of returning empty results later.

---

## Step 2 - Create a collection

The `createCollection` action creates a new vector collection with:

- `title: collectionName`
- embedding model `text-embedding-3-small`
- empty metadata
- header `AI-Resource-Group: default`

Two details matter here:

- `executeRaw()` is used so the code can read the `Location` header from the response.
- The returned value is extracted from that header with `.split("/").at(-2)`.

That means the CAP action returns the collection ID, even though users create the collection by name.

---

## Step 3 - Delete a collection

`deleteCollection` first resolves the collection ID from the name, then deletes it using:

```javascript
await VectorApi.deleteCollectionById(collectionId, {
  "AI-Resource-Group": "default",
}).execute();
```

This keeps the external API symmetric: every action accepts `collectionName`, never `collectionId`.

---

## Step 4 - Ingest one markdown document

The ingestion path is where `@langchain/textsplitters` is used:

```javascript
const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
  chunkSize: 256,
  chunkOverlap: 64,
});
const texts = await splitter.splitText(document);
```

Why chunking is required:

- Embeddings work best on smaller passages than on one giant document.
- Smaller chunks make retrieval more precise.
- Overlap preserves context between neighboring chunks.

The code then uploads a single document whose `chunks` array is built from those split texts:

```javascript
chunks: texts.map((text) => ({
  content: text,
  metadata: [],
}))
```

The action returns the last created document ID:

```javascript
return res.documents.at(-1)?.id;
```

---

## Step 5 - Query the collection

The `query` action uses `RetrievalApi.search()` to search the vector collection:

```javascript
const res = await RetrievalApi.search({
  query: query,
  filters: [
    {
      id: "filter-1",
      searchConfiguration: {
        maxChunkCount: 10,
      },
      dataRepositories: [collectionId],
      dataRepositoryType: "vector",
    },
  ],
}).execute();
```

What this configuration does:

- limits the search to one vector collection
- retrieves up to 10 chunks
- returns the chunk contents, not an LLM answer

The implementation then flattens all retrieved chunks into plain text and joins them with separators:

```javascript
return chunks.join("\n\n---\n\n");
```

This is an important design choice: the service does **retrieval only**. The agent remains responsible for reading those chunks and writing the final answer.

---

# Part 4 - Add a knowledge-base tool to the agent

With the CAP service in place, the agent needs one more tool. Update `agent/srv/agents/bookshop-agent/tools.js`.

Add this tool next to `getBooksTool` and `updateStockTool`:

```javascript
const queryKBTool = tool(
  // runtime aspect
  async ({ query }) => {
    const srv = await cds.connect.to("RAGService");

    const res = await srv.send({
      event: "query",
      data: { query: query, collectionName: "collection-<identity>" },
    });

    return JSON.stringify(res);
  },

  // design time aspect
  {
    name: "query-knowledge-base",
    description: "Queries the Knowledge Base for SAP's AI Practical Use Cases",
    schema: z.object({
      query: z.string().describe("search query"),
    }),
  },
);
```

Then register it in `getTools()`:

```diff
 export const getTools = async () => {
   const mcpTools = await getMcpTools();
 
-  return [getBooksTool, updateStockTool, ...mcpTools];
+  return [getBooksTool, updateStockTool, queryKBTool, ...mcpTools];
 };
```

What the tool does:

- connects to the local `RAGService`
- calls the `query` action
- always searches the collection named `collection-<identity>`
- returns the retrieved text as a stringified tool result

> The current unstaged code uses a concrete collection name. For the handbook and classroom setup, keep it as `collection-<identity>` so every participant works in their own collection namespace.

---

# Part 5 - Teach the agent its third role

Tools do not get called unless the model sees them as relevant. Update the system prompt in `agent/srv/agents/bookshop-agent/agent.js`:

```diff
 export const getAgent = async () => {
   return createAgent({
     model: model,
     systemPrompt:
-      "You are a helpful assistant. You have 2 distinct roles: 1) You can provide information about books and update stock in the bookshop. 2) You can retrieve sales orders in the SAP S/4HANA system.",
+      "You are a helpful assistant. You have 3 distinct roles: 1) You can provide information about books and update stock in the bookshop. 2) You can retrieve sales orders in the SAP S/4HANA system. 3) You can query the Knowledge Base for SAP's AI Practical Use Cases.",
     tools: await getTools(),
     checkpointer: checkpointer,
     middleware: await getMiddlewares(),
   });
 };
```

This is the same pattern you used on Day 10:

- the tool provides the capability
- the prompt advertises the role
- the model decides when to use it

Without that prompt update, the agent may ignore the knowledge-base tool even though it exists.

---

# Part 6 - Prepare a document for ingestion

The repository already contains a sample markdown document:

`samples/sap-ai-practical-use-cases.md`

It is a long reference document about SAP Business AI use cases across:

- Finance
- Human resources
- Marketing and commerce
- Procurement
- Sales and service
- Supply chain

This is a good fit for RAG because:

- it is too large to stuff into the system prompt
- users will ask narrow questions against a broad document
- retrieval can return just the few relevant passages

---

# Part 7 - Test the RAG service directly

Create `agent/test/http/RAGService.http` with requests for creating a collection, ingesting a document, and querying it.

Use this structure:

```http
#############
### LOCAL ###
#############
@server=http://localhost:4004
@header-authorization = Basic alice:

##############
### REMOTE ###
##############
# @server={{$dotenv URL}}

### Request 1: OAuth2 Client Credentials Flow to get an access token
# @name login
POST {{$dotenv AUTH_TOKEN_URL}}
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id={{$dotenv CLIENT_ID}}
&client_secret={{$dotenv CLIENT_SECRET}}

### Save the token to a variable
@header-authorization = Bearer {{login.response.body.access_token}}

##################
### OPERATIONS ###
##################

### createCollection
POST {{server}}/odata/v4/rag/createCollection
Content-Type: application/json
Authorization: {{header-authorization}}

{
  "collectionName": "collection-<identity>"
}

### deleteCollection
POST {{server}}/odata/v4/rag/deleteCollection
Content-Type: application/json
Authorization: {{header-authorization}}

{
  "collectionName": "collection-<identity>"
}

### ingestDocument
POST {{server}}/odata/v4/rag/ingestDocument
Content-Type: application/json
Authorization: {{header-authorization}}

{
  "collectionName": "collection-<identity>",
  "document": "... markdown document content ..."
}

### query
POST {{server}}/odata/v4/rag/query
Content-Type: application/json
Authorization: {{header-authorization}}

{
  "collectionName": "collection-<identity>",
  "query": "quicken payments in finance"
}
```

## Step 1 - Create the collection

Start the agent app:

```bash
cd agent && cds watch
```

Run the `createCollection` request. This should create a fresh vector collection dedicated to your identity.

If you re-run the exercise and want a clean start, use `deleteCollection` first.

---

## Step 2 - Ingest the sample document

Run the `ingestDocument` request with the markdown content from `samples/sap-ai-practical-use-cases.md`.

The request body in the sample HTTP file can contain the document inline, but conceptually you are ingesting that markdown file into the collection.

What happens internally:

1. The collection name is resolved to an ID.
2. The markdown is split into overlapping chunks.
3. Each chunk is embedded.
4. The chunked document is stored in the vector collection.

---

## Step 3 - Query the collection directly

Run the `query` request:

```json
{
  "collectionName": "collection-<identity>",
  "query": "quicken payments in finance"
}
```

You should get back retrieved passages related to finance use cases such as payment matching, late-payment prediction, or cash-flow acceleration.

This direct test is useful because it separates retrieval debugging from agent debugging.

---

# Part 8 - Test the agent end to end

Once the collection is populated and the new tool is registered, query the agent through its normal endpoint.

Run prompts such as:

```json
{ "message": "What are some SAP AI use cases in finance?" }
```

```json
{ "message": "How can AI help automate sales order entry?" }
```

```json
{ "message": "Show me practical SAP AI use cases for service teams." }
```

Expected behavior:

1. The agent recognizes the question is neither about books nor live sales-order data.
2. It selects `query-knowledge-base`.
3. The tool retrieves relevant chunks from `collection-<identity>`.
4. The model synthesizes those chunks into a final answer.

This is the essence of RAG: the model does not memorize the whole document up front. It retrieves only the relevant passages at runtime.

---

# Part 9 - Why this pattern matters

By exposing RAG through a local CAP service and then wrapping that service as a LangChain tool, you keep the architecture clean:

- CAP owns integration with SAP AI SDK.
- The agent only sees a business-level tool.
- The knowledge base can be replaced or extended without rewriting the agent loop.

You also avoid dumping a 40-page document into the system prompt. That would be expensive, noisy, and brittle. Retrieval keeps prompts small and brings in context only when needed.

At this point your agent has three information sources with three different access patterns:

1. Local transactional CAP data through direct tools.
2. Remote S/4HANA data through MCP tools.
3. Unstructured reference knowledge through RAG.

That combination is the foundation for more capable enterprise agents.

## References

- [SAP AI SDK for JavaScript](https://sap.github.io/ai-sdk/docs/js/overview)
- [LangChain Text Splitters](https://js.langchain.com/docs/how_to/code_splitter)
- [Day 11: Refactoring Your Agent - Skills & Middleware](./day-11.md)
