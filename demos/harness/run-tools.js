// harness/run-tools.js —— 第2章：把工具层的四条规矩各演一遍
import { createToolRegistry, readFileTool, writeFileTool, execTool, MAX_READ_LINES, unlinkSync } from "./tools.js";
import { writeFileSync } from "node:fs";

const registry = createToolRegistry([readFileTool, writeFileTool, execTool]);

// 戏1：给模型看的「名片」——只有 name / description / parameters，实现与标记不外泄（决定一）
console.log("── definitions()：模型看到的 ──");
for (const d of registry.definitions()) console.log(`- ${d.name}: ${d.description}`);

// 戏2：只读与可并发是两个开关，且未注册的工具恒 false（决定三）
console.log("\n── canRunConcurrently ──");
for (const call of [
  { name: "read_file", arguments: {} },
  { name: "write_file", arguments: {} },
  { name: "exec", arguments: {} },
  { name: "no_such_tool", arguments: {} },
]) {
  console.log(`${call.name.padEnd(12)} → ${registry.canRunConcurrently(call)}`);
}

// 戏3：截断写明标注、可续读，绝不偷偷丢内容（决定五）
writeFileSync("big.txt", Array.from({ length: 3000 }, (_, i) => `第 ${i + 1} 行`).join("\n"));
const r1 = await registry.execute({ id: "a1", name: "read_file", arguments: { path: "big.txt" } });
const text = r1.content[0].text;
console.log(`\n── read_file 读完 3000 行的大文件 ──`);
console.log(`实际返回 ${text.split("\n").length - 1} 行内容（单次上限 ${MAX_READ_LINES}），结尾标注：`);
console.log(text.trimEnd().split("\n").slice(-1)[0]);
const cont = await registry.execute({ id: "a2", name: "read_file", arguments: { path: "big.txt", offset: 2001, limit: 3 } });
console.log(`offset=2001 续读 → ${cont.content[0].text.trimEnd().split("\n").join(" | ")}`);

// 戏4：失败也是结果，不是异常；未注册工具也不崩（决定四）
const bad = await registry.execute({ id: "b1", name: "exec", arguments: { command: 'node -e "process.exit(3)"' } });
console.log(`\n── exec 退出码 3 ──`);
console.log(`isError=${bad.isError}，回传给模型: ${bad.content[0].text}`);
const unknown = await registry.execute({ id: "b2", name: "no_such_tool", arguments: {} });
console.log(`未注册工具 → isError=${unknown.isError}，回传给模型: ${unknown.content[0].text}`);

unlinkSync("big.txt"); // 清理 demo 临时文件
console.log("\n（big.txt 已清理。registry 接口没变：node run.js 仍按第1章原样能跑。）");
