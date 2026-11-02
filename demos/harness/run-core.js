// harness/run-core.js —— 第9章：Run（一次执行的唯一实现）+ 服务端传输细节
// 裁自 mini-pi packages/core/src/run.ts 与 packages/client/src/server/{sse,http}.ts（简化）。
// 内核不打印、不着色、不读 TTY：这里产出的是**数据**，事件流由订阅者各自去画。

import { randomBytes } from "node:crypto";
import { runAgentLoop } from "./loop.js";
import { textBlock } from "./messages.js";

/** 终态：pending / running / done / cancelled / error——终态只有一个 */
export const RUN_STATUSES = ["pending", "running", "done", "cancelled", "error"];

/**
 * 生成 runId：可读、进程内唯一，并且**不可猜**。
 * 时间戳 + 自增序号能被直接枚举：本机其它进程按格式试几轮就能读到别人的
 * 事件流。末尾带 4 字节随机数，枚举成本从「试几次」变成「撞 2^32 次」；
 * 前缀与时间戳仍保留，日志里照样一眼看出先后。
 */
let runSeq = 0;
export function newRunId(prefix = "run") {
  runSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${runSeq.toString(36)}_${randomBytes(4).toString("hex")}`;
}

/**
 * Run——「跑一次」的唯一实现：终端一个回合、headless 一次 exec、服务端一个任务，
 * 走同一段代码。区别只在谁订阅事件、谁来回答审批。
 */
export class Run {
  #status = "pending";
  #listeners = new Set();
  #controller = new AbortController();
  #externalAbort = null;
  runId;
  signal;

  constructor({ systemPrompt, messages, tools, model, maxTurns = 100, signal } = {}) {
    this.runId = newRunId();
    this.signal = this.#controller.signal;
    this.#input = { systemPrompt, messages, tools, model, maxTurns };
    // 外部取消源**转发进来**而不是另起一个：取消父任务必须一次收掉整棵子树，
    // 各起一个信号的结果是「取消父任务，子 Agent 还在跑」
    if (signal) {
      const forward = () => this.cancel();
      if (signal.aborted) this.#controller.abort();
      else {
        signal.addEventListener("abort", forward, { once: true });
        this.#externalAbort = () => signal.removeEventListener("abort", forward);
      }
    }
  }
  #input;

  getStatus() { return this.#status; }

  /** 订阅事件流；返回取消订阅的函数 */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 取消本次执行；已结束的 Run 再取消是无操作 */
  cancel() {
    if (["done", "cancelled", "error"].includes(this.#status)) return;
    this.#controller.abort();
  }

  /**
   * 执行。抛错只在基础设施故障时发生——模型调用失败由循环自己消化成一条消息，
   * 不算 error（error 只留给「注册表都造不出来」这类基础设施故障），
   * 因此调用方拿到的永远是「这次执行的结论」，不需要再猜。
   */
  async execute(hooks = {}) {
    const startedAt = Date.now();
    this.#status = "running";
    const emit = (event) => { hooks.onEvent?.(event); for (const l of this.#listeners) l(event); };
    try {
      // 工具集可以是注册表，也可以是「按 Run 现造」的工厂——
      // 工厂是委派能按 Run 隔离的关键（每个 Run 的工具闭包住自己那一个容器）
      const tools = typeof this.#input.tools === "function" ? this.#input.tools() : this.#input.tools;
      const { newMessages } = await runAgentLoop({
        systemPrompt: this.#input.systemPrompt,
        messages: this.#input.messages,
        tools,
        model: this.#input.model,
        maxTurns: this.#input.maxTurns,
        beforeToolCall: hooks.beforeToolCall,
        signal: this.signal,
        onDelta: (text) => emit({ type: "delta", text }),
        onTurnEnd: hooks.onTurnEnd,
      });
      this.#status = this.signal.aborted ? "cancelled" : "done";
      return { runId: this.runId, status: this.#status, newMessages, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      this.#status = this.signal.aborted ? "cancelled" : "error";
      return {
        runId: this.runId, status: this.#status, newMessages: [],
        elapsedMs: Date.now() - startedAt,
        ...(this.#status === "error" ? { error: String(error?.message ?? error) } : {}),
      };
    } finally {
      this.#externalAbort?.(); // 无论怎么结束都要解除外部监听：残留就是下一个 Run 的地雷
    }
  }
}

// ---------- 服务端传输细节（裁自 sse.ts / http.ts） ----------

/** SSE 帧编码：SSE 规定每个换行都要单独带 data:，否则第一行之后的内容被当成新字段静默丢弃 */
export function encodeSseFrame(seq, event) {
  const body = JSON.stringify(event) ?? "{}";
  const lines = body.split("\n").map((line) => `data: ${line}`);
  return `id: ${seq}\nevent: ${event.type}\n${lines.join("\n")}\n\n`;
}

/** 心跳：注释行不触发前端事件，只用来把「连接已死」尽早暴露成写失败 */
export const HEARTBEAT_FRAME = ": ping\n\n";

function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.0\/8|\[::1\]|127\.\d+\.\d+\.\d+)(:\d+)?$/i.test(host);
}

/**
 * 只接受本机来源：服务虽监听 127.0.0.1，仍要校验 Host 与 Origin——
 * 挡的是 DNS rebinding：恶意网页把自己的域名解析到 127.0.0.1，就能以同源身份打这个服务。
 * Origin 若存在，端口必须与 Host 一致（127.0.0.1:9999 是另一个本地服务）；Origin: null 同样拒绝。
 */
export function assertLocalRequest({ host, origin } = {}) {
  if (!host) throw new Error("403：请求缺少 Host 头，只接受本机浏览器的同源请求");
  if (!isLocalHost(host)) throw new Error(`403：Host 非本机：${host}`);
  if (origin && origin !== "null") {
    const originHost = origin.replace(/^https?:\/\//, "");
    if (!isLocalHost(originHost)) throw new Error(`403：Origin 非本机：${origin}`);
    if (host && originHost.split(":")[1] !== host.split(":")[1]) {
      throw new Error(`403：Origin 端口与 Host 不一致：${origin}`);
    }
  }
}
