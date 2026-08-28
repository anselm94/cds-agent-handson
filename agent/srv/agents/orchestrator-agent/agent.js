import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import {
  buildAzureContentSafetyFilter,
  buildDpiMaskingProvider,
} from "@sap-ai-sdk/orchestration";
import { context, createAgent } from "langchain";
import { getA2aServerUrl } from "../../a2a/a2a-utils.js";
import { getMiddlewares } from "./middlewares.js";
import { getTools } from "./tools.js";

const checkpointer = new MemorySaver(); // short-term memory
const store = new InMemoryStore(); // long-term memory

const model = new OrchestrationClient({
  promptTemplating: {
    model: {
      name: "gpt-5.4",
    },
  },

  filtering: {
    // content filtering for input and output to ensure safe content handling
    input: {
      filters: [
        buildAzureContentSafetyFilter("input", {
          violence: "ALLOW_ALL",
          hate: "ALLOW_SAFE_LOW_MEDIUM",
          sexual: "ALLOW_SAFE_LOW_MEDIUM",
          prompt_shield: true, // prompt attack mitigation
        }),
      ],
    },
    output: {
      filters: [
        buildAzureContentSafetyFilter("output", {
          violence: "ALLOW_ALL",
          hate: "ALLOW_SAFE_LOW_MEDIUM",
          sexual: "ALLOW_SAFE_LOW_MEDIUM",
        }),
      ],
    },
  },

  masking: {
    masking_providers: [
      buildDpiMaskingProvider({
        // sap data privacy integration for anonymization/pseudoanonymization of sensitive data
        method: "pseudonymization",
        entities: [
          "profile-person",
          "profile-address",
          "profile-email",
          "profile-username-password",
        ],
      }),
    ],
  },
});

export const getAgent = async () => {
  return createAgent({
    model: model,
    systemPrompt: context`You are a helpful assistant. 
    
    You have 2 roles:
      1. Query the Knowledge Base for SAP's AI Practical Use Cases, when asked for.
      2. You have access to 2 distinct subagents. Determine which subagent is best suited to handle the request and forward the request to the appropriate subagent. The subagents are:
        - Bookshop Agent: Can provide information about books and update stock in the bookshop.
        - Sales Order Agent: Can retrieve sales orders in the SAP S/4HANA system.

    Important:
      - For every request, you must 
        a. read user preferences to tailor your responses
        b. If the user has preferences, save the preferences. 
      - While forwarding the request to the subagents for information, include the user preferences so that the subagents can provide personalized responses.
      - Respond back to the user in markdown format.
  `,
    tools: await getTools(),
    middleware: await getMiddlewares(),
    checkpointer: checkpointer,
    store: store,
  });
};

export const AgentCard = {
  name: "super-agent",
  description:
    "Provides information about books, allows updating stock, pulls sales orders from S/4, provides SAP's AI use cases and orchestrates subagents.",
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
    {
      id: "query-kb",
      name: "Query Knowledge Base",
      description:
        "Queries the Knowledge Base for SAP's AI Practical Use Cases",
      tags: ["knowledge base", "SAP", "AI"],
      examples: [
        "What are some practical use cases of AI in SAP?",
        "List AI use cases in SAP's Knowledge Base",
      ],
      outputModes: ["text/plain"],
    },
    {
      id: "get-sales-orders",
      name: "Get Sales Orders",
      description: "Retrieves sales orders from the SAP S/4HANA system",
      tags: ["sales orders", "SAP", "S/4HANA"],
      examples: [
        "Get all sales orders for customer ID 12345",
        "Retrieve sales orders created in the last 7 days",
      ],
      outputModes: ["text/plain"],
    },
  ],
  supportsAuthenticatedExtendedCard: false,
  protocolVersion: "0.3.0",
};
