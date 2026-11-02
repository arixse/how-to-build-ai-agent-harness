// harness/session.js —— 第4章：JSONL 会话存储（追加、容错加载、压缩）
// 裁自 mini-pi packages/core/src/agent/sessionStore.ts（简化：去掉多链分叉，保留单链）。
// 铁律：会话文件是历史的唯一来源——宁可少压、宁可报警告，绝不静默丢用户的数据。

import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { textBlock } from "./messages.js";
import { estimateTokens, alignCompactionStart } from "./context.js";

/** 决定二：整份重写必须原子（先写临时文件再 rename）——进程写一半被杀也不留残缺文件 */
function writeFileAtomicSync(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 清不掉不影响主流程 */ }
    throw e;
  }
}

/** 决定二：逐行结构校验——合法 JSON 但缺字段，JSON.parse 兜不住，必须单独验 */
function validateEntry(value) {
  if (typeof value !== "object" || value === null) return { reason: "不是 JSON 对象" };
  if (typeof value.type !== "string") return { reason: "缺少 type 字段" };
  if (value.type === "session")
    return typeof value.version === "number" && typeof value.id === "string"
      ? { entry: value } : { reason: "session 缺少 version/id" };
  if (value.type === "message") {
    if (typeof value.id !== "string") return { reason: "message 缺少 id" };
    if (!("parentId" in value)) return { reason: "message 缺少 parentId" };
    if (typeof value.message !== "object" || value.message === null)
      return { reason: "message 缺少 message" };
    const role = value.message.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult")
      return { reason: `message.role 非法：${String(role)}` };
    return { entry: value };
  }
  if (value.type === "compaction") {
    if (typeof value.id !== "string") return { reason: "compaction 缺少 id" };
    if (typeof value.summary !== "string") return { reason: "compaction 缺少 summary" };
    if (typeof value.firstKeptEntryId !== "string") return { reason: "compaction 缺少 firstKeptEntryId" };
    return { entry: value };
  }
  return { reason: `未知的条目类型：${value.type}` };
}

export function createSessionStore(filePath, { cwd = process.cwd() } = {}) {
  const entries = [];       // 全量条目（含头行与压缩记录）
  const byId = new Map();
  let leafId = null;
  let counter = 0;
  let lastCompactionError = null;
  const loadWarnings = [];

  const nextId = () => `entry_${++counter}`;

  // ---------- 加载（决定二：读时容错，绝不重建文件） ----------
  function loadOrCreate() {
    if (!existsSync(filePath)) {
      const header = { type: "session", version: 1, id: "harness-session", timestamp: new Date().toISOString(), cwd };
      entries.push(header);
      writeFileAtomicSync(filePath, `${JSON.stringify(header)}\n`);
      return;
    }
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();

    // 末尾残行：完整行补换行；半行从文件截掉（数据已写坏，留不住）——
    // 不截的话下次 append 会紧贴它写，两条残缺 JSON 粘成一行，新消息也跟着解析失败
    if (lines.length > 0 && !raw.endsWith("\n")) {
      const last = lines.at(-1);
      let ok = false;
      try { ok = !("reason" in validateEntry(JSON.parse(last))); } catch { ok = false; }
      if (ok) writeFileAtomicSync(filePath, `${raw}\n`);
      else {
        lines.pop();
        writeFileAtomicSync(filePath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
        loadWarnings.push({ line: lines.length + 1, reason: "文件末尾是写了一半的消息行，已截断（该条无法恢复）" });
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "") continue;
      let value;
      try { value = JSON.parse(line); } catch (e) {
        loadWarnings.push({ line: i + 1, reason: String(e?.message ?? e) });
        continue; // 决定二：单行损坏只跳过该行，不让整份会话打不开
      }
      const r = validateEntry(value);
      if ("reason" in r) { loadWarnings.push({ line: i + 1, reason: r.reason }); continue; }
      entries.push(r.entry);
      if (r.entry.type !== "session") {
        byId.set(r.entry.id, r.entry);
        leafId = r.entry.id;
        counter = Math.max(counter, Number(r.entry.id.replace("entry_", "")) || 0);
      }
    }

    // 头行损坏：只补头行，其余原始行原样保留——旧实现用 "w" 重写，把整份历史截没了
    if (!entries.some((e) => e.type === "session")) {
      const header = { type: "session", version: 1, id: "harness-session", timestamp: new Date().toISOString(), cwd };
      entries.unshift(header);
      const kept = loadWarnings.some((w) => w.line === 1) ? lines.slice(1) : lines;
      writeFileAtomicSync(filePath, [JSON.stringify(header), ...kept].join("\n") + "\n");
    }
  }

  // ---------- 追加（决定一：先写盘再改内存，一批一次 appendFile） ----------
  function appendMessages(messages) {
    if (messages.length === 0) return [];
    const written = [];
    let parentId = leafId;
    for (const message of messages) {
      const id = nextId();
      written.push({ type: "message", id, parentId, timestamp: new Date().toISOString(), message });
      parentId = id;
    }
    appendFileSync(filePath, written.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
    for (const e of written) { entries.push(e); byId.set(e.id, e); }
    leafId = parentId; // 写失败时内存保持原样，调用方按「整批未落盘」重试
    return written.map((e) => e.id);
  }

  // ---------- 上下文重建（决定五：摘要以 user 消息打头，最近消息优先级更高） ----------
  function pathToLeaf() {
    const reversed = [];
    let current = leafId ? byId.get(leafId) : undefined;
    while (current) { reversed.push(current); current = current.parentId ? byId.get(current.parentId) : undefined; }
    return reversed.reverse(); // push 后 reverse，O(n)（unshift 是 O(n²)，源码注释里的真事故）
  }

  function buildContext() {
    const path = pathToLeaf();
    let idx = -1;
    for (let i = path.length - 1; i >= 0; i--) if (path[i].type === "compaction") { idx = i; break; }
    if (idx === -1) return path.filter((e) => e.type === "message").map((e) => e.message);
    const compaction = path[idx];
    const messages = [{
      role: "user",
      content: [textBlock(`以下是旧的上下文摘要。后续回答必须参考它，但最近的消息优先级更高。\n\n${compaction.summary}`)],
      timestamp: Date.now(),
    }];
    let found = false;
    for (let i = 0; i < idx; i++) {
      if (path[i].id === compaction.firstKeptEntryId) found = true;
      if (found && path[i].type === "message") messages.push(path[i].message);
    }
    for (let i = idx + 1; i < path.length; i++) if (path[i].type === "message") messages.push(path[i].message);
    return messages;
  }

  // ---------- 压缩（决定五：失败不写盘不丢历史；决定四：窗口起点对齐） ----------
  function needsCompaction(maxTokens, keepRecent) {
    const msgs = pathToLeaf().filter((e) => e.type === "message");
    if (msgs.length <= Math.max(1, keepRecent)) return false;
    return estimateTokens(buildContext()) > maxTokens;
  }

  async function compactIfNeeded({ maxTokens, keepRecent, model, signal } = {}) {
    if (signal?.aborted) return undefined;
    if (!needsCompaction(maxTokens, keepRecent)) return undefined;
    const msgs = pathToLeaf().filter((e) => e.type === "message");
    const startIndex = alignCompactionStart(msgs.map((m) => m.role), keepRecent);
    if (startIndex <= 0) return undefined; // 整段都要保留才能维持配对：宁可不压

    const summarized = msgs.slice(0, startIndex);
    const kept = msgs.slice(startIndex);
    const tokensBefore = estimateTokens(buildContext());

    let summary;
    try {
      summary = model
        ? await summarizeEntries(summarized, model, signal)
        : `对话共 ${summarized.length} 条消息`; // 未配模型才允许简单摘要兜底
    } catch (e) {
      // 决定五：压缩失败保持原上下文、不写任何条目——降级摘要等于把真实历史换成统计数字
      lastCompactionError = String(e?.message ?? e);
      return undefined;
    }
    if (signal?.aborted) return undefined;

    const entry = {
      type: "compaction", id: nextId(), parentId: leafId,
      timestamp: new Date().toISOString(), summary,
      firstKeptEntryId: kept[0].id, tokensBefore,
    };
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    entries.push(entry); byId.set(entry.id, entry); leafId = entry.id;
    lastCompactionError = null;
    return entry;
  }

  loadOrCreate();
  return {
    appendMessages,
    buildContext,
    needsCompaction,
    compactIfNeeded,
    getEntries: () => [...entries],
    getLoadWarnings: () => [...loadWarnings],
    getLastCompactionError: () => lastCompactionError,
    getFilePath: () => filePath,
  };
}

/** 用模型生成摘要（对齐 sessionStore.ts summarizeEntries）：失败/截断/空回复都抛出，绝不回退到统计废话 */
async function summarizeEntries(summarized, model, signal) {
  const conversationText = summarized
    .map((e) => `${e.message.role === "user" ? "用户" : e.message.role === "assistant" ? "助手" : "工具"}: ${
      (e.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n") || "（无正文）"
    }`)
    .join("\n\n");
  const response = await model.complete({
    systemPrompt: "你是对话摘要助手。把对话历史压成 200 字以内的摘要，保留用户意图、关键结论与执行进度。",
    messages: [{ role: "user", content: [textBlock(`请为以下对话生成摘要：\n\n${conversationText}`)], timestamp: Date.now() }],
    tools: [],
    signal,
  });
  // 先看结束原因再看内容：失败时模型也返回一条 assistant（stopReason:"error"），当摘要写入等于用错误描述替换真实历史
  if (response.stopReason === "error") throw new Error(`摘要模型调用失败`);
  if (response.stopReason === "length") throw new Error("摘要被截断（stopReason=length），已放弃本次压缩");
  if (response.stopReason === "aborted") throw new Error("摘要模型调用已取消");
  const summary = (response.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (summary === "") throw new Error("摘要模型返回了空内容");
  return summary;
}
