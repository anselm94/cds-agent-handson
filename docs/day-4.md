```
cds init
```

---

In `srv/services.cds`

```cds
service AgentService {
    action invoke(message: String) returns String;
}
```

---

```
cds add nodejs
```

---

```
npm install
```

---

```
cds watch
```

---

```
npm install langchain @langchain/core
```

---

```
npm install @sap-ai-sdk/langchain
```

---

Create a file `.env.example`

```properties
AICORE_SERVICE_KEY={"serviceurls":{"AI_API_URL":"https://..."},"clientid":"...","clientsecret":"...","url":"https://..."}
destinations=[{"name": "capla-mcp-api", "url": "http://localhost:4005", "username": "alice", "password": "alice"}]
```

---

Copy `.env.example` to `.env` file. 

And add `.env` at the end of `.gitignore` file

---

Update the `.env` file with your AICORE_SERVICE_KEY and destination credentials.

---

Create a file `srv/agents/hello-world-agent.js`

```javascript
import { createAgent } from 'langchain';
import { OrchestrationClient } from '@sap-ai-sdk/langchain';

const model = new OrchestrationClient({
  promptTemplating: {
    model: {
      name: 'gpt-5.4'
    }
  }
});

const agent = createAgent({
  model: model,
  systemPrompt: "You are a helpful SAP assistant."
});

const agentInputs = {
  messages: [{ role: 'user', content: 'What is SAP?' }]
};

const result = await agent.invoke(agentInputs);

console.log(result.messages[0].content)
```

---

```
SET AICORE_SERVICE_KEY='...'

node srv/agents/hello-world-agent.js
```
