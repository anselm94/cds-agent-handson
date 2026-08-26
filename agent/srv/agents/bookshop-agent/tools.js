import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import cds from "@sap/cds";
import { tool } from "langchain";
import { z } from "zod";
import {
  resolveDestinationHeaders,
  resolveDestinationUrl,
} from "../../mcp/utils.js";
import { SKILLS } from "./skills.js";

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

const queryKBTool = tool(
  // runtime aspect
  async ({ query }) => {
    const srv = await cds.connect.to("RAGService");

    const res = await srv.send({
      event: "query",
      data: { query: query, collectionName: "collection-anselm" },
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

export const getTools = async () => {
  const mcpTools = await getMcpTools();

  return [
    getBooksTool,
    updateStockTool,
    queryKBTool,
    getUserInfo,
    saveUserPreferences,
    getUserPreferences,
    ...mcpTools,
  ];
};

export const loadSkill = tool(
  // runtime aspect
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

  // design time aspect
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
