import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import cds from "@sap/cds";
import express from "express";
import { LangChainAgentExecutor } from "./a2a/a2a-executor.js";
import {
  bookshopAgent,
  AgentCard as BookshopAgentCard,
} from "./agents/bookshop-agent.js";

const LOG = cds.log("a2a-agent");

cds.on("bootstrap", async (app) => {
  const routerA2A = express.Router();
  routerA2A.use(cds.middlewares.before);

  const taskStore = new InMemoryTaskStore();
  const agentExecutor = new LangChainAgentExecutor(bookshopAgent);

  // A2A JSON-RPC endpoint
  routerA2A.get(`/.well-known/agent.json`, (_, res) =>
    res.json(BookshopAgentCard),
  );

  routerA2A.use(
    "/",
    jsonRpcHandler({
      requestHandler: new DefaultRequestHandler(
        BookshopAgentCard,
        taskStore,
        agentExecutor,
      ),
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.use("/a2a", routerA2A);

  LOG.info(`A2A agent endpoint mounted:`);
  LOG.info(`  Bookshop: GET  /.well-known/agent.json`);
});
