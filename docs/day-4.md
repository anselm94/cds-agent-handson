# Day 4: Building Your First AI Agent with SAP CAP and LangChain

In this hands-on session, you will scaffold a CAP (Cloud Application Programming) project, expose it as an OData service, and wire it up to a LangChain-powered AI agent running on SAP AI Core.

---

## Step 1 — Initialize a new CDS project

Run the CDS initializer to scaffold a new project in the current directory. This creates the standard CAP folder structure (`app/`, `db/`, `srv/`) along with a `package.json`.

```bash
cds init
```

---

## Step 2 — Define the Agent Service

Create (or open) `srv/agent-service.cds` and add a service definition that exposes a single `invoke` action. This action accepts a user message and returns a string response — the interface your agent will implement.

```cds
service AgentService {
    action invoke(message: String) returns String;
}
```

---

## Step 3 — Add Node.js runtime support

Add Node.js-specific configuration to the project. This adjusts `package.json` and project settings so the CAP server runs as a Node.js application.

```bash
cds add nodejs
```

---

## Step 4 — Install project dependencies

Install all Node.js packages declared in `package.json`.

```bash
npm install
```

---

## Step 5 — Start the development server

Launch the CDS development server with live-reload. Open `http://localhost:4004` in your browser to confirm the `AgentService` is listed and accessible.

```bash
cds watch
```

---

## Step 6 — Install LangChain

Install the core LangChain packages. These provide the agent framework, tool abstractions, and message types used to build AI agents in Node.js.

```bash
npm install langchain @langchain/core
```

---

## Step 7 — Install the SAP AI SDK LangChain adapter

Install the SAP AI SDK integration for LangChain. This package provides `OrchestrationClient`, which connects LangChain to SAP AI Core's Orchestration service for model invocation.

```bash
npm install @sap-ai-sdk/langchain
```

---

## Step 8 — Create the environment configuration template

Create a file named `.env.example` at the project root. This acts as a template showing which environment variables are required, without storing real credentials in source control.

```properties
AICORE_SERVICE_KEY={"serviceurls":{"AI_API_URL":"https://..."},"clientid":"...","clientsecret":"...","url":"https://..."}
destinations=[{"name": "capla-mcp-api", "url": "http://localhost:4005", "username": "alice", "password": "alice"}]
```

- **`AICORE_SERVICE_KEY`** — The full service key JSON for your SAP AI Core instance, obtained from the BTP cockpit.
- **`destinations`** — A list of named HTTP destinations used by the CAP server (here pointing to a local MCP API).

---

## Step 9 — Secure your credentials

Copy the template to a real `.env` file, then ensure it is never committed to source control:

```bash
cp .env.example .env
```

Append `.env` to `.gitignore`:

```
.env
```

> `.env` holds sensitive credentials. Never commit it to a repository.

---

## Step 10 — Fill in your credentials

Open `.env` and replace the placeholder values:

- Set `AICORE_SERVICE_KEY` to the JSON service key from your SAP AI Core service instance in BTP.
- Update the `destinations` entry if your local MCP API runs on a different port or requires different credentials.

---

## Step 11 — Create the Hello World agent

Create the file `srv/agents/hello-world-agent.js`. This agent uses `OrchestrationClient` to call GPT via SAP AI Core and `createAgent` from LangChain to orchestrate the conversation.

```javascript
import { createAgent } from 'langchain';
import { OrchestrationClient } from '@sap-ai-sdk/langchain';

// Connect to SAP AI Core via the Orchestration service
const model = new OrchestrationClient({
  promptTemplating: {
    model: {
      name: 'gpt-5.4'
    }
  }
});

// Create a reusable agent with a system persona
const agent = createAgent({
  model: model,
  systemPrompt: "You are a helpful SAP assistant."
});

const agentInputs = {
  messages: [{ role: 'user', content: 'What is SAP?' }]
};

const result = await agent.invoke(agentInputs);

console.log(result.messages[0].content);
```

---

## Step 12 — Run the agent

On **Windows**, set the environment variable inline and execute the script:

```powershell
SET AICORE_SERVICE_KEY='...'
node srv/agents/hello-world-agent.js
```

On **macOS/Linux**, use:

```bash
node srv/agents/hello-world-agent.js
```

(The `.env` file is loaded automatically by the CDS runtime when using `cds watch`, or you can use a package like `dotenv` for standalone scripts.)

You should see the agent's response printed to the console — your first AI agent on SAP AI Core is working!
