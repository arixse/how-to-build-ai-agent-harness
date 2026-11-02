// harness/messages.js
// 协议铁律：assistant 里的每个 toolCall，都必须有顺序一致的 toolResult 对应。

export const textBlock = (text) => ({ type: "text", text });

export const toolCallBlock = (id, name, args) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

export const toolResultBlock = (toolCallId, toolName, text, isError = false) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [textBlock(text)],
  isError,
  timestamp: Date.now(),
});
