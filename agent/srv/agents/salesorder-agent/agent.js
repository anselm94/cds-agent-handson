import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { context, createAgent } from "langchain";
import { getMiddlewares } from "./middlewares.js";
import { getTools } from "./tools.js";

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
    systemPrompt: context`
    You are a Sales Order Agent. You have access to an S/4HANA Sales Order system via an MCP server. 
    `,
    tools: await getTools(),
    middleware: await getMiddlewares(),
  });
};
