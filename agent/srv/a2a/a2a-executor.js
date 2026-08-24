import { Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import cds from "@sap/cds";
import {
  createNewTask,
  createTaskUpdate
} from "./a2a-utils.js";

const LOG = cds.log("a2a-agent");

export class LangChainAgentExecutor {
  #agent;

  constructor(agent) {
    this.#agent = agent;
  }

  async execute(ctx, eventBus) {
    const userMessage = ctx.userMessage;
    const existingTask = ctx.task;
    const taskId = existingTask?.id || cds.utils.uuid();
    const contextId =
      userMessage.contextId || existingTask?.contextId || cds.utils.uuid();

    const textParts = userMessage.parts.filter((part) => part.kind === "text");
    const messageText = textParts.map((part) => part.text).join(" ");

    LOG.info(
      `Executing agent with contextId: ${contextId} and taskId: ${taskId} for userMessage: ${messageText}`,
    );

    const config = {
      context: {
        id: cds.context?.id,
        user: cds.context?.user?.id,
        tenant: cds.context?.tenant,
      },
      configurable: {
        thread_id: contextId,
      },
    };

    if (!existingTask) {
      eventBus.publish(createNewTask(contextId, taskId, userMessage));
    }

    eventBus.publish(
      createTaskUpdate(contextId, taskId, "Thinking...", "working"),
    );

    try {
      const state = await this.#agent.graph.getState(config);

      let res;
      if (ctx.task || state.tasks.length > 0) {
        const decision = messageText.toLowerCase().includes("approve")
          ? "approve"
          : messageText.toLowerCase().includes("reject")
            ? "reject"
            : null;
        res = await this.#agent.invoke(
          new Command({
            resume: { decisions: [{ type: decision }] }, // or "reject"
          }),
          config,
        );
      } else {
        res = await this.#agent.invoke(
          {
            messages: [{ role: "user", content: messageText }],
          },
          config,
        );
      }

      if (isInterrupted(res)) {
        const requests = [];
        for (const i of res[INTERRUPT]) {
          for (const actionRequest of i.value.actionRequests) {
            requests.push(actionRequest.description);
          }
        }
        const msg = requests.join("\n");
        eventBus.publish(
          createTaskUpdate(contextId, taskId, msg, "input-required"),
        );
      } else {
        const msg = res.messages[res.messages.length - 1].content;
        eventBus.publish(createTaskUpdate(contextId, taskId, msg, "completed"));
      }
    } catch (error) {
      LOG.error(`Error executing agent: ${error}`);
      eventBus.publish(
        createTaskUpdate(contextId, taskId, `Error: ${error}`, "failed"),
      );
    }

    eventBus.finished();
  }

  cancelTask = async (taskId, eventBus) => {};
}
