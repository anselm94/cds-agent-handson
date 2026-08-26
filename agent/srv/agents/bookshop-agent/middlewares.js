import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { createMiddleware, summarizationMiddleware } from "langchain";
import { SKILLS } from "./skills.js";
import { loadSkill } from "./tools.js";
import { z } from "zod";
import { StateSchema } from "@langchain/langgraph";

const model = new OrchestrationClient({
  promptTemplating: {
    model: {
      name: "gpt-5.4",
    },
  },
});

// Build skills prompt from the SKILLS list
const skillsPrompt = SKILLS.map(
  (skill) => `- **${skill.name}**: ${skill.description}`,
).join("\n");

const skillMw = createMiddleware({
  name: "skillMiddleware",
  tools: [loadSkill],
  wrapModelCall: async (request, handler) => {
    // Build the skills addendum
    const skillsAddendum =
      `\n\n## Available Skills\n\n${skillsPrompt}\n\n` +
      "Use the load_skill tool when you need detailed information " +
      "about handling a specific type of request.";

    // Append to system prompt
    const newSystemMessage = request.systemMessage.concat(skillsAddendum);

    return handler({
      ...request,
      systemMessage: newSystemMessage,
    });
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
  return [skillMw, summarizationMw, stateExtMw];
};
