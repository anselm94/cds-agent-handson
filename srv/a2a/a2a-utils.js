import cds from "@sap/cds";

export function createNewTask(contextId, taskId, message) {
  return {
    kind: "task",
    contextId: contextId,
    id: taskId,
    status: { state: "submitted", timestamp: new Date().toISOString() },
    history: [message],
    metadata: message.metadata,
  };
}

export function createTaskUpdate(contextId, taskId, message, status) {
  const statusMessage =
    typeof message === "string"
      ? createMessage(contextId, taskId, message)
      : message;
  return {
    kind: "status-update",
    taskId: taskId,
    contextId: contextId,
    status: {
      state: status,
      timestamp: new Date().toISOString(),
      message: statusMessage,
    },
    final:
      status !== "working" && status !== "submitted" && status !== "unknown",
  };
}

export function createMessageUpdate(
  contextId,
  taskId,
  message,
  append = false,
  lastChunk = true,
) {
  return {
    kind: "artifact-update",
    taskId: taskId,
    contextId: contextId,
    artifact: {
      artifactId: cds.utils.uuid(),
      parts: [{ kind: "text", text: message }],
    },
    append: append,
    lastChunk: lastChunk,
  };
}

export function createInterruptUpdate(message, options) {
  return {
    kind: "status-update",
    taskId: options.taskId,
    contextId: options.contextId,
    status: {
      state: "input-required",
      message: {
        kind: "message",
        role: "agent",
        messageId: cds.utils.uuid(),
        parts: [{ kind: "text", text: message }],
        taskId: options.taskId,
        contextId: options.contextId,
      },
      timestamp: new Date().toISOString(),
    },
    final: false,
  };
}

export function createMessage(contextId, taskId, message) {
  return {
    kind: "message",
    messageId: cds.utils.uuid(),
    role: "agent",
    parts: [{ kind: "text", text: message }],
    taskId: taskId,
    contextId: contextId,
  };
}

const VCAP = process.env.VCAP_APPLICATION;
export const getA2aServerUrl = () =>
  VCAP
    ? `https://${JSON.parse(VCAP).application_uris[0]}/a2a`
    : "http://localhost:4004/a2a";
