import { createAgent } from 'langchain';
import { OrchestrationClient } from '@sap-ai-sdk/langchain';

const model = new OrchestrationClient({
  promptTemplating: {
    model: {
      name: 'gpt-5.4'
    }
  }
});

export const helloAgent = createAgent({
  model: model,
  systemPrompt: "You are a helpful SAP assistant."
});
