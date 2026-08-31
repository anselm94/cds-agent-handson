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
    systemPrompt: context`You are a Bookshop Agent that can provide information about books, update stock and predict prices for books in the bookshop.`,
    tools: await getTools(),
    middleware: await getMiddlewares(),
  });
};
