import cds from "@sap/cds";
import { tool } from "langchain";
import { z } from "zod";
import { getAgent as getSalesOrderAgent } from "../salesorder-agent/agent.js";
import { getAgent as getBookshopAgent } from "../bookshop-agent/agent.js";

const LOG = cds.log("orchestrator-agent");

const queryKBTool = tool(
  // runtime aspect
  async ({ query }) => {
    LOG.info(
      `Querying Knowledge Base for SAP's AI Practical Use Cases with query: ${query}`,
    );

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

    LOG.info(
      `Retrieving user info for userId: ${userId}, tenantId: ${tenantId}`,
    );

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

    LOG.info(`Saved preferences for userId: ${userId}`);

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

    LOG.info(
      `Retrieved preferences for userId: ${userId}: ${preferences?.value}`,
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

const askSalesOrderAgent = tool(
  async ({ query }) => {
    LOG.info(`Asking Sales Order Agent: ${query}`);

    const subagent = await getSalesOrderAgent();
    const res = await subagent.invoke({
      messages: [{ role: "user", content: query }],
    });
    return res.messages.at(-1)?.text || "No response from Sales Order Agent.";
  },
  {
    name: "ask-sales-order-agent",
    description: "Ask a question to the Sales Order Agent and get a response.",
    schema: z.object({
      query: z.string().describe("Query"),
    }),
  },
);

const askBookshopAgent = tool(
  async ({ query }) => {
    LOG.info(`Asking Bookshop Agent: ${query}`);

    const subagent = await getBookshopAgent();
    const res = await subagent.invoke({
      messages: [{ role: "user", content: query }],
    });
    return res.messages.at(-1)?.text || "No response from Bookshop Agent.";
  },
  {
    name: "ask-bookshop-agent",
    description: "Ask a question to the Bookshop Agent and get a response.",
    schema: z.object({
      query: z.string().describe("Query"),
    }),
  },
);

export const getTools = async () => {
  return [
    queryKBTool,
    getUserInfo,
    saveUserPreferences,
    getUserPreferences,
    askSalesOrderAgent,
    askBookshopAgent,
  ];
};
