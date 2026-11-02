// harness/run-delivery.js —— 第9章 demo：同一内核的 N 张脸
// 戏1 终端 / headless / SSE 服务端三张脸，走同一个 Run
// 戏2 终态语义：模型失败 ≠ error；基础设施故障才是 error
// 戏3 runId 不可猜 + 取消级联  戏4 传输细节：SSE 帧 / 心跳 / 本机来源校验

import http from "node:http";
import { textBlock, toolCallBlock } from "./messages.js";
import { createMockModel } from "./model.js";
import { createToolRegistry, readFileTool } from "./tools.js";
import { Run, newRunId, encodeSseFrame, HEARTBEAT_FRAME, assertLocalRequest } from "./run-core.js";

// 注意：不用 silent 包装——Run 总是把 onDelta 换成「发事件」，内核自己不打印
const scriptedModel = (turns) => createMockModel(turns);

// ---------- 戏 1：三张脸，同一个 Run ----------
{
  const turns = [
    { content: [toolCallBlock("c1", "read_file", { path: "messages.js" })], stopReason: "toolUse" },
    { content: [textBlock("messages.js 定义了三种内容块，铁律是 toolCall 与 toolResult 配对同序。")], stopReason: "stop" },
  ];
  const makeRun = () =>
    new Run({
      systemPrompt: "你是助手。",
      messages: [{ role: "user", content: [textBlock("总结一下 messages.js")], timestamp: Date.now() }],
      tools: createToolRegistry([readFileTool]),
      model: scriptedModel(turns),
      maxTurns: 10,
    });

  // 脸 1：终端——订阅事件流，自己画字
  console.log("【戏1·终端】");
  const t1 = makeRun();
  t1.subscribe((e) => { if (e.type === "delta") process.stdout.write(`▸${e.text}`); });
  const r1 = await t1.execute();
  console.log(`\n           （status=${r1.status}；终端自己决定怎么画：加前缀、着色都行）`);

  // 脸 2：headless——不订阅，只拿 JSON 结论（管道 / CI 用）
  const r2 = await makeRun().execute();
  console.log(`\n【戏1·headless】status=${r2.status}，结论=${JSON.stringify(r2.newMessages.at(-1).content[0].text.slice(0, 22) + "……")}，elapsed=${r2.elapsedMs}ms`);

  // 脸 3：服务端——同一个 Run，事件经 SSE 推给浏览器
  const runs = new Map();
  const server = http.createServer((req, res) => {
    try { assertLocalRequest({ host: req.headers.host, origin: req.headers.origin }); } catch (e) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return res.end(String(e.message));
    }
    if (req.method === "POST" && req.url === "/api/runs") {
      const run = makeRun();
      const buffer = [];
      let seq = 0;
      run.subscribe((event) => buffer.push({ seq: ++seq, event }));
      runs.set(run.runId, { run, buffer });
      run.execute(); // fire-and-forget：事件经订阅者进 buffer，SSE 连接随时来补
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ runId: run.runId }));
    }
    const m = /^\/api\/runs\/([^/]+)\/events$/.exec(req.url ?? "");
    if (req.method === "GET" && m && runs.has(m[1])) {
      const { run, buffer } = runs.get(m[1]);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      for (const item of buffer) res.write(encodeSseFrame(item.seq, item.event)); // 断线重连：先补发游标之后的事件
      const unsub = run.subscribe((event) => {
        const item = { seq: buffer.length + 1, event };
        buffer.push(item);
        res.write(encodeSseFrame(item.seq, item.event));
      });
      const hb = setInterval(() => res.write(HEARTBEAT_FRAME), 1000);
      const finish = setInterval(() => {
        if (["done", "cancelled", "error"].includes(run.getStatus())) {
          clearInterval(hb); clearInterval(finish); unsub();
          res.write(encodeSseFrame(buffer.length + 1, { type: "done", status: run.getStatus() }));
          res.end();
        }
      }, 20);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const post = await fetch(`http://127.0.0.1:${port}/api/runs`, { method: "POST" });
  const { runId } = await post.json();
  console.log(`\n【戏1·服务端】POST /api/runs → ${runId}，SSE 事件流：`);
  const es = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/events`);
  const reader = es.body.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    const frames = acc.split("\n\n");
    acc = frames.pop(); // 最后一段可能不完整，留到下一轮
    for (const frame of frames) {
      if (!frame.trim()) continue;
      console.log(frame.trim().split("\n").map((l) => "           " + l).join("\n"));
      if (frame.includes("event: done")) break outer;
    }
  }
  server.close();
}

// ---------- 戏 2：终态语义——模型失败 ≠ error ----------
{
  const failModel = scriptedModel([{ content: [textBlock("上游返回了错误说明……")], stopReason: "error" }]);
  const r1 = await new Run({ systemPrompt: "", messages: [], tools: createToolRegistry([readFileTool]), model: failModel, maxTurns: 5 }).execute();
  console.log(`\n【戏2】模型调用失败 → status=${r1.status}（循环自己把它消化成一条消息，执行本身是完成的）`);

  // 基础设施故障：注册表工厂抛错（造不出工具集）→ 才是 error
  const r2 = await new Run({ systemPrompt: "", messages: [], tools: () => { throw new Error("注册表构造失败"); }, model: scriptedModel([]), maxTurns: 5 }).execute();
  console.log(`【戏2】基础设施故障   → status=${r2.status}，error=${JSON.stringify(r2.error)}`);
}

// ---------- 戏 3：runId 不可猜 + 取消级联 ----------
{
  console.log(`\n【戏3】runId 样例 = ${newRunId()}（时间戳+序号可读，末尾 4 字节随机防枚举）`);
  const ac = new AbortController();
  const slowModel = scriptedModel([{ content: [textBlock("慢慢想……")], stopReason: "stop" }]);
  const run = new Run({ systemPrompt: "", messages: [], tools: createToolRegistry([readFileTool]), model: slowModel, maxTurns: 5, signal: ac.signal });
  const p = run.execute();
  ac.abort(); // 外部取消源（Ctrl+C / HTTP 取消）转发进来
  const r = await p;
  console.log(`【戏3】外部取消 → status=${r.status}；终态后再 cancel 是无操作，status 仍是`, run.getStatus());
}

// ---------- 戏 4：传输细节 ----------
{
  console.log("\n【戏4】SSE 帧（每个换行都要单独带 data:）：");
  console.log(encodeSseFrame(3, { type: "delta", text: "第一行\n第二行" }).trimEnd().split("\n").map((l) => "       " + l).join("\n"));
  console.log("       心跳帧 =", JSON.stringify(HEARTBEAT_FRAME), "（注释行不触发前端事件，只尽早暴露死连接）");

  for (const req of [
    { host: "127.0.0.1:3000", origin: "http://evil.example" },
    { host: "127.0.0.1:3000", origin: "http://127.0.0.1:9999" },
    { host: undefined, origin: undefined },
    { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
  ]) {
    try { assertLocalRequest(req); console.log("       放行:", JSON.stringify(req)); }
    catch (e) { console.log("       拒绝:", JSON.stringify(req), "→", e.message); }
  }
}
