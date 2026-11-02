// harness/tools.js —— 第2章升级版：注册表 + 只读分级 + 结果回传（第1章简化版见正文 3.3）
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { toolResultBlock } from "./messages.js";

// ── 参数取值：模型传来的参数类型不可信（同一个字段有时给数字、有时给数字字符串）──
export const stringArg = (value, fallback) =>
  typeof value === "string" && value.trim() ? value : fallback;

export const numberArg = (value, fallback) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
};

// ── 只读名单：唯一事实来源（决定二）。
// 同一个集合服务三件事：注册表 readOnly 标记、审批免确认白名单（第6章）、并发批次收集。
// 此前各写一份时，新增只读工具必然遗漏，于是分叉。
export const READ_ONLY_TOOL_NAMES = ["read_file", "grep", "glob"];
const READ_ONLY_TOOLS = new Set(READ_ONLY_TOOL_NAMES);

// ── read_file 的上限（决定五）：写明截断、可续读，绝不偷偷丢内容 ──
export const MAX_READ_CHARS = 20_000;          // 单次最大字符数（源码 files.ts）
export const MAX_READ_LINES = 2_000;           // 单次最大行数
export const MAX_READ_BYTES = 5 * 1024 * 1024; // 超过直接拒绝：读不完也读不动

export function createToolRegistry(defs) {
  const map = new Map();
  for (const def of defs) {
    // readOnly 集中按名单标记，不散落在各工具定义里（决定二）。
    // concurrent 是另一个开关（决定三）：能不能同时跑，与「是否只读」无关。
    map.set(def.name, { ...def, readOnly: READ_ONLY_TOOLS.has(def.name) });
  }
  return {
    // 给模型看的「名片」：只有名字、说明、参数 schema，实现与标记不外泄（决定一）
    definitions() {
      return [...map.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
    },
    isReadOnly(name) {
      return map.get(name)?.readOnly === true;
    },
    // 未注册的工具恒 false：不知道的东西不让并发，是最安全的默认（决定三）
    canRunConcurrently(call) {
      if (this.isReadOnly(call.name)) return true;
      const rule = map.get(call.name)?.concurrent;
      return typeof rule === "function" ? rule(call.arguments ?? {}) : rule === true;
    },
    // 失败也是结果（决定四）：任何路径都返回 toolResult，绝不向上抛——
    // 抛出去这一轮就「缺结果」落盘，是非法序列（第1章决定五）。
    async execute(toolCall, signal) {
      const tool = map.get(toolCall.name);
      if (!tool) return toolResultBlock(toolCall.id, toolCall.name, `未知工具: ${toolCall.name}`, true);
      try {
        const out = await tool.run(toolCall.arguments ?? {}, signal);
        return toolResultBlock(toolCall.id, toolCall.name, out.text, out.isError ?? false);
      } catch (e) {
        return toolResultBlock(toolCall.id, toolCall.name, String(e?.message ?? e), true);
      }
    },
  };
}

// 读文件：带显式截断标注，模型看到标记可用 offset 继续读（决定五）
export const readFileTool = {
  name: "read_file",
  description: `读取文本文件。单次最多返回 ${MAX_READ_LINES} 行 / ${MAX_READ_CHARS} 字符，截断时附标注，可用 offset 继续读。`,
  parameters: { path: "string", offset: "number（可选，起始行，从 1 计）", limit: "number（可选，最多行数）" },
  concurrent: true, // 只读且可并发——两个开关都为真，但语义不同（决定三）
  run: ({ path, offset, limit }) => {
    const start = Math.max(1, Math.floor(numberArg(offset, 1)));
    const maxLines = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(numberArg(limit, MAX_READ_LINES))));
    const stat = statSync(path);
    if (stat.size > MAX_READ_BYTES) {
      return {
        isError: true,
        text: `文件过大（${stat.size} 字节，上限 ${MAX_READ_BYTES}）：改用 grep / exec 检索更省上下文`,
      };
    }
    // 二进制嗅探：只读前 8KB 找空字节，不把整个文件读进内存
    const fd = openSync(path, "r");
    const head = Buffer.alloc(8_000);
    const headBytes = readSync(fd, head, 0, 8_000, 0);
    closeSync(fd);
    if (head.subarray(0, headBytes).includes(0)) {
      return { isError: true, text: "疑似二进制文件（前 8KB 含空字节）：不支持读取" };
    }
    const lines = readFileSync(path, "utf8").split("\n");
    const slice = lines.slice(start - 1, start - 1 + maxLines);
    let out = "", used = 0, count = 0;
    for (const line of slice) {
      const cost = Buffer.byteLength(line, "utf8") + 1;
      if (used + cost > MAX_READ_CHARS) break;
      out += line + "\n";
      used += cost;
      count++;
    }
    const lastLine = start + count - 1;
    if (count > 0 && lastLine < lines.length) {
      // 写明截断：告诉模型读到了哪、还剩多少、怎么继续——不偷偷丢内容
      out += `\n...[已截断：本次返回第 ${start}-${lastLine} 行（共 ${lines.length} 行），用 offset=${lastLine + 1} 继续读]`;
    }
    return { text: out };
  },
};

// 写文件：会改变状态 → 串行，且永远不在只读名单里
export const writeFileTool = {
  name: "write_file",
  description: "把文本写入文件（覆盖原内容）。会改变状态。",
  parameters: { path: "string", content: "string" },
  concurrent: false,
  run: ({ path, content }) => {
    writeFileSync(stringArg(path, ""), stringArg(content, ""), "utf8");
    return { text: `已写入 ${path}` };
  },
};

// 执行命令：会改变状态 → 串行。失败也是结果：保留输出与退出码（决定四）
export const execTool = {
  name: "exec",
  description: "执行 shell 命令并返回输出。会改变状态。",
  parameters: { command: "string" },
  concurrent: false,
  run: ({ command }) => {
    try {
      const out = execSync(stringArg(command, ""), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { text: out.trim() || "(无输出)" };
    } catch (e) {
      const detail = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      return {
        isError: true,
        text: `命令失败（退出码 ${e.status ?? "?"}）：${detail || e.message}`.slice(0, 2_000),
      };
    }
  },
};

// 供 demo 清理临时文件用
export { unlinkSync };
