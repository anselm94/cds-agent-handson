import { StateSchema } from "@langchain/langgraph";
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { createMiddleware, summarizationMiddleware } from "langchain";
import { z } from "zod";

const model = new OrchestrationClient({
  promptTemplating: {
    model: {
      name: "gpt-5.4",
    },
  },
});

const summarizationMw = summarizationMiddleware({
  model: model,
  trigger: {
    tokens: 4000,
  },
  keep: {
    messages: 10,
  },
});

const UserState = new StateSchema({
  userId: z.string(),
  tenantId: z.string().optional(),
});

const stateExtMw = createMiddleware({
  name: "StateExtension",
  stateSchema: UserState,
});

export const getMiddlewares = async () => {
  return [summarizationMw, stateExtMw];
};
