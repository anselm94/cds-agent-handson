import cds from "@sap/cds";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { tool } from "langchain";
import { z } from "zod";
import {
  resolveDestinationHeaders,
  resolveDestinationUrl,
} from "../../mcp/utils.js";
import { SKILLS } from "./skills.js";

const LOG = cds.log("salesorder-agent");

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

export const getTools = async () => {
  const mcpTools = await getMcpTools();

  return [...mcpTools];
};

export const loadSkill = tool(
  // runtime aspect
  async ({ skillName }) => {
    // Find and return the requested skill
    const skill = SKILLS.find((s) => s.name === skillName);
    if (skill) {
      LOG.info(`Loaded skill: ${skillName}`);

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
