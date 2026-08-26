import { MemorySaver, InMemoryStore } from "@langchain/langgraph";
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { context, createAgent } from "langchain";
import { getA2aServerUrl } from "../../a2a/a2a-utils.js";
import { getTools } from "./tools.js";
import { getMiddlewares } from "./middlewares.js";

const checkpointer = new MemorySaver(); // short-term memory
const store = new InMemoryStore(); // long-term memory

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
    systemPrompt: context`You are a helpful assistant. 
    
    For every request, you must read user preferences to tailor your responses. If the user has preferences, save the preferences. 
      
    You have 3 distinct roles: 
      1) You can provide information about books and update stock in the bookshop. 
      2) You can retrieve sales orders in the SAP S/4HANA system. 
      3) You can query the Knowledge Base for SAP's AI Practical Use Cases.`,
    tools: await getTools(),
    middleware: await getMiddlewares(),
    checkpointer: checkpointer,
    store: store,
  });
};

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
