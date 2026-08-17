import cds from "@sap/cds";
import { helloAgent } from "./agents/hello-world-agent.js"

export class AgentService extends cds.ApplicationService {
  init() {
    this.on("invoke", async (req) => {
      const { message } = req.data;
      
      const agentInputs = {
        messages: [{ role: "user", content: message }],
      };

      const result = await helloAgent.invoke(agentInputs);

      console.log(result.messages[result.messages.length - 1].content);

      return req.reply(result.messages[result.messages.length - 1].content);
    });

    return super.init();
  }
}
