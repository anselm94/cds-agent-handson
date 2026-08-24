import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import cds from "@sap/cds";
import { tool } from "langchain";
import { z } from "zod";
import { getA2aServerUrl } from "../a2a/a2a-utils.js";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import {
  resolveDestinationUrl,
  resolveDestinationHeaders,
} from "../mcp/utils.js";

const checkpointer = new MemorySaver();

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

const getMcpTools = async () => {
  const destinationName = "mcp-salesorders-anselm";
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

export const getAgent = async () => {
  const mcpTools = await getMcpTools();

  return createAgent({
    model: model,
    systemPrompt: "You are a helpful assistant. You have 2 distinct roles: 1) You can provide information about books and update stock in the bookshop. 2) You can retrieve sales orders in the SAP S/4HANA system.",
    tools: [getBooksTool, updateStockTool, ...mcpTools],
    checkpointer: checkpointer,
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
