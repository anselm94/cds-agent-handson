import cds from "@sap/cds";
import { getAgent } from "./agents/bookshop-agent.js"

export class AgentService extends cds.ApplicationService {
  init() {
    this.on("invoke", async (req) => {
      const { message } = req.data;
      
      const agentInputs = {
        messages: [{ role: "user", content: message }],
      };

      const bookshopAgent = await getAgent();
      const result = await bookshopAgent.invoke(agentInputs);

      console.log(result.messages[result.messages.length - 1].content);

      return req.reply(result.messages[result.messages.length - 1].content);
    });

    return super.init();
  }
}
