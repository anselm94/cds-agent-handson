import cds from "@sap/cds";
import { getAgent } from "./agents/orchestrator-agent/agent.js";

export class AgentService extends cds.ApplicationService {
  init() {
    this.on("invoke", async (req) => {
      const { message } = req.data;

      const agentInputs = {
        messages: [{ role: "user", content: message }],
        userId: cds.context?.user?.id,
        tenantId: cds.context?.tenant,
      };

      const orchestratorAgent = await getAgent();
      const result = await orchestratorAgent.invoke(agentInputs, {
        configurable: {
          thread_id: cds.context.id,
        },
      });

      console.log(result.messages[result.messages.length - 1].content);

      return req.reply(result.messages[result.messages.length - 1].content);
    });

    return super.init();
  }
}
