# Day 14: Small HITL Refinements

Day 14 is a small follow-up to the human-in-the-loop flow from [Day 8](./day-08.md).

The main HITL wiring is already in place. This day only adds three small refinements:

1. Register LangChain's `humanInTheLoopMiddleware()`.
2. Make the resume path more tolerant of human replies.
3. Keep Joule's `taskId` only while the agent is waiting for input.

---

## 1. Add the HITL middleware

In `agent/srv/agents/bookshop-agent/middlewares.js`, import and register `humanInTheLoopMiddleware()`:

```javascript
import {
  createMiddleware,
  summarizationMiddleware,
  humanInTheLoopMiddleware,
} from "langchain";

const humanInTheLoopMw = humanInTheLoopMiddleware({
  interruptOn: {
    update_stock: {
      allowedDecisions: ["approve", "reject"],
      description: "🚨 Update stock requires approval",
    },
  },
  descriptionPrefix: "Tool execution pending approval",
});

export const getMiddlewares = async () => {
  return [skillMw, summarizationMw, stateExtMw, humanInTheLoopMw];
};
```

What this changes:

- Calls to `update_stock` can now pause before execution.
- The human can only answer with `approve` or `reject`.
- The interrupt message shown to the user comes from this middleware configuration.

This is intentionally narrow: only the stock update tool is protected.

---

## 2. Make the resume path less brittle

In `agent/srv/a2a/a2a-executor.js`, adjust how the executor interprets the human reply:

```javascript
const decision = messageText.toLowerCase().includes("approve")
  ? "approve"
  : messageText.toLowerCase().includes("reject")
    ? "reject"
    : messageText;
```

Before this change, any reply that was neither `approve` nor `reject` became `null`.

Now:

- `approve` still maps to `approve`
- `reject` still maps to `reject`
- anything else is passed through as-is

That gives the resume path a little more flexibility when the human sends free text instead of a strict button-style answer.

---

## 3. Tighten Joule capability context handling

In `agent/joule-capability/functions/call_agent.yaml`, the request body and `taskId` handling are slightly refined:

```yaml
parameters:
  - name: contextId
    optional: true
  - name: taskId
    optional: true

action_groups:
  - actions:
      - type: agent-request
        agent_type: remote
        system_alias: BookshopAssistantA2A
        body: >
          {
            "contextId": "<? contextId ?>",
            "taskId": "<? taskId ?>"
          }
        result_variable: result

      - type: set-variables
        variables:
          - name: contextId
            value: <? result.body.contextId ?>
          - name: taskId
            value: "<? result.body.status.state ?> == 'input-required' ? result.body.taskId : null"
```

Why this helps:

- Joule now sends `contextId` and `taskId` on every call.
- `taskId` is now read from `result.body.taskId` and only kept when the agent returns `input-required`.
- Once the interrupted step is resolved, `taskId` is cleared so later prompts are treated as normal conversation turns, not stale resume attempts.

`contextId` still stays stable across turns, so the LangGraph thread continues as before.

---

## 4. Quick demo

Run a prompt that triggers `update_stock`, for example:

```json
{ "message": "Increase stock for book 201 by 5" }
```

Expected flow:

1. The agent pauses and returns an approval request.
2. Joule surfaces the interrupt message.
3. Reply with `approve`.
4. The agent resumes the same conversation and completes the stock update.

You can also try `reject` to confirm the tool call is blocked.

## Reference

- [Day 8: Connecting Your A2A Agent to SAP Joule](./day-08.md)
