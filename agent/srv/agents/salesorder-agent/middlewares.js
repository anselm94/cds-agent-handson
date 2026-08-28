import { createMiddleware } from "langchain";
import { SKILLS } from "./skills.js";
import { loadSkill } from "./tools.js";

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

export const getMiddlewares = async () => {
  return [skillMw];
};
