# 第 3 章：模型层可靠性 —— 别让你的 Agent「说到一半卡死」

上一章你搭好了循环：Agent 问模型、模型回话、要调工具就调。看起来很美。

但有个事实没人会提前告诉你：**调用 AI 模型，是整个系统里最不可靠的一环。** 它走的是网络，而网络什么都干得出来。

## 1. 先弄明白：调用模型时都会出什么幺蛾子（What）

你以为「问模型」就是发个请求、拿回一段文字。现实是：

- **它连接上了，但迟迟不说话。** 正常请求有个连接超时（比如 120 秒），但那只能管到「拿到响应头」。一旦连接建立、开始收数据，很多 SDK 就不再计时了。如果上游发到一半突然没声——可能是发布滚挂了、负载均衡死了、网络半开——你的程序会**永远卡在那儿**，重试也不会触发，用户只能干按 Ctrl+C。
- **它说「你太频繁了，稍后再来」。** 这就是限流（HTTP 429）。服务器忙不过来，请你等会儿。
- **它读着读着被掐断。** 流式输出是一段一段来的，读到一半连接断了，你拿到的是半句残 answer。
- **它报错了，你得重试。** 超时、5xx、网络抖动，这些都该重试。但重试有讲究。
- **最阴的一招：字已经吐给用户了。** 流式是边收边显示的，用户屏幕上已经有半句答案。这时候如果失败要重试，你不能把那半句再播一遍——否则用户看到重复文字，而且**同样的提问被算了两次钱**。

把这五件事捋清楚，你就知道模型层这层「壳」要防什么了。下面这张表先给你个全景，后面一节讲它怎么转：

| 故障 | 对策 | 源码里的数字 |
| --- | --- | --- |
| 连接/响应头超时 | SDK 超时 120s | `REQUEST_TIMEOUT_MS` |
| 正文读到一半没声 | 静默看门狗 120s | `STREAM_IDLE_TIMEOUT_MS` |
| 限流/5xx/网络错 | 重试，最多 3 次 | `MAX_REQUEST_ATTEMPTS` |
| 重试要等多久 | 1s→2s 指数退避 + 抖动 | `RETRY_BASE_DELAY_MS` / `RETRY_JITTER_RATIO` |
| 已显示的文字 | 绝不重发、绝不重算 | —— |

<!-- code-ref: packages/core/src/agent/model/config.ts#L9 -->
<!-- code-ref: packages/core/src/agent/model/config.ts#L18 -->
<!-- code-ref: packages/core/src/agent/model/config.ts#L26 -->

## 2. 它怎么把这些都兜住（How）

把源码里无关的分支裁掉，核心就是两样东西：**一道看门狗**和**一个重试器**。

**看门狗（watchdog）**负责正文阶段：它盯着「两段数据之间隔了多久」。只要收到数据就重置计时，一旦静默超过 120 秒，就判定上游挂死，中止请求。注意它和 SDK 那道 120 秒是**两道独立**的——SDK 管连接，它管正文，互不替代。

<!-- code-ref: packages/core/src/agent/model/stream.ts#L36-L88 -->

**重试器**负责失败重来：遇到限流、5xx、网络错，最多试 3 次（含首次）。每次等待不是固定的，而是**指数退避**——第一次等 1 秒，第二次等 2 秒——并且会参考服务端明确说的「请等 X 毫秒」（Retry-After 头），取两者里**较大的**那个，再叠加 ±20% 的随机抖动，免得一堆客户端同时重试、把服务器冲垮。

<!-- code-ref: packages/core/src/agent/model/retry.ts#L11 -->
<!-- code-ref: packages/core/src/agent/model/retry.ts#L14 -->
<!-- code-ref: packages/core/src/agent/model/retry.ts#L169-L194 -->
<!-- code-ref: packages/core/src/agent/model/retry.ts#L72-L102 -->
<!-- code-ref: packages/core/src/agent/model/retry.ts#L110-L119 -->

还有一条反直觉的铁律：**一旦文字已经显示给用户，这一次的失败就绝不重试。** 代码里专门有个「已外发追踪器」记着「到底有没有吐过字」，吐过了就抛一个不可重试的错误。

<!-- code-ref: packages/core/src/agent/model/stream.ts#L130-L151 -->

## 3. 为什么非得这么设计（Why）

### 3.1 为什么是「两道」计时器，而不是一道

SDK 自带的超时只能管到「连接 + 响应头」。如果只靠它，正文读取阶段**完全没有上限**——这就是 1.1 里「永远卡死」的源头。所以必须另设一道专门管正文的。两道都取 120 秒，是为了让头阶段的时限保持原样，只把此前裸奔的正文阶段纳入约束。

**代价**：多维护一个计时器，且它刻意不能让进程因为它而提前退出（不 `unref`），否则事件循环会误判为空、静默超时永远不触发。

### 3.2 为什么要把 SDK 自己的重试关掉（`maxRetries: 0`）

OpenAI / Anthropic 的 SDK 默认会重试 2 次。如果你在应用层又写一层（最多 3 次），两套叠起来变成最多 **9 次**请求——而每次重试都会把你的提问（prompt token）再发一遍，**重复计费**。所以必须显式关掉 SDK 的，自己全权接管。

**代价**：退避、抖动、识别 Retry-After、区分「用户取消」这些逻辑都得自己写。但换来的是「重试几次、等多久、什么不重试」全在你手里、可测可控。

<!-- code-ref: packages/core/src/agent/model/retry.ts#L165-L167 -->

### 3.3 为什么退避要和 Retry-After 取较大者，还要加抖动

服务端在 429 响应里会告诉你「请 20 秒后再来」。如果你不读这个头、自己只等 1 秒就再打，反而是在加剧限流——人家让你歇 20 秒，你 1 秒后就撞上去。所以取较大者。加 ±20% 抖动，是为了别让一堆客户端在同一毫秒同时重试，形成流量尖峰把服务器冲死。

**代价**：判定「可重试」得沿着错误的 `cause` 链往里钻——SDK 把网络失败包了一层后，`status`/`code` 都成了 `undefined`，原始的出错原因只在最里层。这活儿不难但容易漏。

### 3.4 为什么「已外发正文就绝不重试」

重试的单位是「完整一次请求」。但正文是流式实时显示给用户的，delta 已经上屏。如果读完整个流之后再重试，用户会看到**同样的半句答案出现两次**，并且被**收两次钱**——这比直接失败还糟。

**代价**：正文阶段一旦出岔子，只能「认栽」给个可操作的提示，不能悄无声息地重来。这是主动接受的代价。

<!-- code-ref: packages/core/src/agent/model/stream.ts#L130-L151 -->

### 3.5 为什么 `length`（回答被截断）要映射成 `length`，而不是「已取消」

模型回答太长会被输出上限截断，这时上游给的结束原因是 `length`。必须如实映射成 `length`，绝不能当成「用户取消了」。因为「取消」在界面上会说「已取消」，而用户实际看到的是「答案被截断了」——提示完全错位。正确做法是告诉用户「可以把 maxTokens 调大」。默认值 `DEFAULT_MAX_TOKENS` 是 8192（旧值 4096 太容易触发截断）。

**代价**：这个结束原因会存进历史、出现在状态栏，映射错了会让「这一轮在等工具」看起来像「模型说完了」，所以即便回复里带着工具调用、结束原因却写成 `stop`，也要修正成 `toolUse`。

<!-- code-ref: packages/core/src/agent/model/stream.ts#L236-L249 -->
<!-- code-ref: packages/core/src/agent/model/stream.ts#L290-L296 -->

## 4. 踩过的坑（都是源码注释里的真事）

1. **看门狗掐断后，流居然「干净地结束」了。** `for await` 不抛错，正常退出。结果产出一条「正常结束」的截断回复，比挂死还隐蔽。后来加了一道「返回前再判一次」才拦住。
2. **9 次请求重复计费。** 上线初期没关 SDK 重试，应用层 3 次 × SDK 2 次 = 9 次，prompt token 被反复发、反复算钱。
3. **漏读 Retry-After 反而加剧限流。** 自己接管重试后，有一版没读响应头里的等待时间，服务端说「20 秒后再来」，客户端 1 秒后就再打。
4. **`status`/`code` 是 `undefined`。** SDK 把 `fetch` 失败包了一层，错误上这些字段都没了，原始 errno 只在 `cause` 链上，判定可重试必须沿链下钻。
5. **把 `length` 误当「取消」。** 输出上限截断被映射成取消，用户得到错误的「已取消」提示，而不是「调大 maxTokens」。

## 5. 实现 + demo：给模型层装上可靠性壳

落在累积式 `harness/` 项目里，本章新增两份文件：`model-reliable.js`（把**任意**有 `complete()` 的模型包上可靠性壳——第 1 章的 `loop.js` 一行不用改）和 `flaky-model.js`（一个专出事故的假模型，demo 用它**确定性**复现三类故障，不依赖真实 API）。真实常量与源码一致：看门狗 120s、重试最多 3 次、退避基准 1s、抖动 ±20%；demo 里把时长缩小成 300ms/80ms，方便肉眼看着触发。

### 5.1 `model-reliable.js` —— 可靠性壳

```js
// harness/model-reliable.js
// 真实常量来自源码 config.ts / retry.ts：
//   REQUEST_TIMEOUT_MS = 120_000 / STREAM_IDLE_TIMEOUT_MS = 120_000（两道独立计时）
//   MAX_REQUEST_ATTEMPTS = 3（含首次）/ RETRY_BASE_DELAY_MS = 1_000 / RETRY_JITTER_RATIO = 0.2
export const STREAM_IDLE_TIMEOUT_MS = 120_000;
export const MAX_REQUEST_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_JITTER_RATIO = 0.2;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("等待重试时被用户取消")); }, { once: true });
  });

// 单次尝试：包一道「静默看门狗」。它与 SDK 的连接超时是两道独立计时——
// SDK 只管到「拿到响应头」，这里管的是「正文阶段两段数据之间隔了多久」。
function completeOnce(inner, args, idleTimeoutMs) {
  return new Promise((resolve, reject) => {
    const attemptAc = new AbortController(); // 每次尝试一个独立信号，看门狗触发时掐断上游
    const onOuterAbort = () => attemptAc.abort(args.signal?.reason);
    args.signal?.addEventListener("abort", onOuterAbort, { once: true });

    let timer;
    const fireIdle = () => {
      const err = new Error("正文静默超时：两段数据之间隔了太久，判定上游挂死");
      err.kind = "stream_idle_timeout";
      attemptAc.abort(); // 关键：把卡死的上游真的掐断，不能只 reject 自己
      reject(err);
    };
    const bump = () => { clearTimeout(timer); timer = setTimeout(fireIdle, idleTimeoutMs); };
    bump(); // 计时从请求发出就开始——正文迟迟不来也算静默

    inner.complete({
      ...args,
      signal: attemptAc.signal,
      onDelta: (t) => { bump(); args.onDelta?.(t); }, // 有数据 → 重置计时
    }).then(
      (v) => { clearTimeout(timer); args.signal?.removeEventListener("abort", onOuterAbort); resolve(v); },
      (e) => { clearTimeout(timer); args.signal?.removeEventListener("abort", onOuterAbort); reject(e); },
    );
  });
}

function isRetryable(e) {
  if (e?.kind === "stream_idle_timeout") return true;                 // 看门狗：上游装死
  if (e?.kind === "http") return e.status === 429 || e.status >= 500; // 限流 / 服务端错
  if (e?.kind === "network") return true;                             // 网络抖动 / 读一半被掐
  return false;                                                       // 其余（编程错误等）不重试
}

// 退避：1s → 2s 指数增长；与服务端 Retry-After 取较大者；再叠加 ±20% 抖动
export function backoffDelayMs(attempt, baseDelayMs, jitterRatio, retryAfterMs) {
  const expo = baseDelayMs * 2 ** (attempt - 1);
  const wait = Math.max(expo, retryAfterMs ?? 0);
  const factor = 1 - jitterRatio + Math.random() * jitterRatio * 2; // 0.8 ~ 1.2
  return Math.round(wait * factor);
}

/**
 * 把任意「有 complete() 的模型」包上可靠性壳：
 * - 看门狗：正文静默超时 → 掐断上游 → 记为可重试
 * - 重试：限流/5xx/网络错最多 3 次，指数退避 + Retry-After 取大 + 抖动
 * - 铁律：只要有一个字已经吐给用户（onDelta 调过），这次失败绝不重试
 */
export function withReliability(inner, opts = {}) {
  const idleTimeoutMs = opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_REQUEST_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const jitterRatio = opts.jitterRatio ?? RETRY_JITTER_RATIO;
  const log = opts.log ?? (() => {});

  return {
    async complete(args = {}) {
      const { signal } = args;
      let emitted = false; // 「已外发追踪器」：吐过一个字就绝不重试
      const onDelta = (t) => { emitted = true; args.onDelta?.(t); };

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await completeOnce(inner, { ...args, onDelta }, idleTimeoutMs);
        } catch (e) {
          if (signal?.aborted) throw e; // 用户取消 ≠ 可重试故障，直接交出去
          if (emitted) {
            e.emitted = true; // 正文已部分上屏：重试会重复显示、重复计费，只能认栽
            throw e;
          }
          if (!isRetryable(e) || attempt === maxAttempts) throw e;
          const delay = backoffDelayMs(attempt, baseDelayMs, jitterRatio, e.retryAfterMs);
          log(`  [retry] 第 ${attempt} 次失败（${e.kind ?? e.message}），约 ${delay}ms 后重试`);
          await sleep(delay, signal);
        }
      }
    },
  };
}
```

### 5.2 `flaky-model.js` —— 专出事故的假模型

真实项目里被包的 `inner` 就是调真实 API 的流式模型；demo 用下面这个假模型确定性复现三类故障：

```js
// harness/flaky-model.js
import { textBlock } from "./messages.js";

const hangUntilAborted = (signal) =>
  new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("被看门狗掐断"), { kind: "stream_idle_timeout" })), { once: true });
    // 不 resolve、不 reject：模拟「连接还在、正文永远不来」
  });

export function createFlakyModel(scenario) {
  let calls = 0;
  return {
    async complete({ signal, onDelta } = {}) {
      if (signal?.aborted) return { role: "assistant", content: [], stopReason: "aborted" };
      calls++;
      if (scenario === "stall" && calls === 1) {
        await hangUntilAborted(signal);       // 戏1：一个字不吐然后装死 → 看门狗掐断 → 重试成功
      }
      if (scenario === "rate-limit" && calls <= 2) {
        const err = new Error("HTTP 429 Too Many Requests");
        err.kind = "http"; err.status = 429; err.retryAfterMs = 400;
        throw err;                            // 戏2：前两次都限流（Retry-After=400ms），第三次放行
      }
      if (scenario === "mid-stream-drop") {
        onDelta?.("这半句已经上屏了，");
        const err = new Error("正文读到一半连接被掐断");
        err.kind = "network";
        throw err;                            // 戏3：先吐半句再断 → 已外发，绝不重试
      }
      return { role: "assistant", content: [textBlock("一切正常，任务完成。")], stopReason: "stop" };
    },
  };
}
```

### 5.3 跑起来，看三出戏

```js
// harness/run-reliable.js
import { withReliability } from "./model-reliable.js";
import { createFlakyModel } from "./flaky-model.js";

// demo 把 120s/1s 缩小成 300ms/80ms 方便观察；真实常量见 model-reliable.js 顶部注释
const opts = { idleTimeoutMs: 300, baseDelayMs: 80, jitterRatio: 0.2, log: console.log };

// 戏1：静默装死 → 看门狗掐断 → 自动重试成功
{
  const model = withReliability(createFlakyModel("stall"), opts);
  const r = await model.complete({ onDelta: (t) => process.stdout.write(t) });
  console.log("\n[戏1] 看门狗 + 重试救回来了 →", r.content[0].text, "\n");
}

// 戏2：连续两次 429（Retry-After=400ms）→ 退避取大 + 抖动 → 第三次成功
{
  const model = withReliability(createFlakyModel("rate-limit"), opts);
  const r = await model.complete({});
  console.log("[戏2] 退避重试救回来了 →", r.content[0].text, "\n");
}

// 戏3：吐了半句才断 → 已外发 → 绝不重试，把错误交出去
{
  const model = withReliability(createFlakyModel("mid-stream-drop"), opts);
  try {
    await model.complete({ onDelta: (t) => process.stdout.write(t) });
  } catch (e) {
    console.log("\n[戏3] 已上屏 → 拒绝重试（否则重复显示、重复计费）→", e.message);
  }
}
```

运行：

```bash
cd demos/harness && node run-reliable.js
```

预期输出（重试等待时间带 ±20% 抖动，每次运行略有不同）：

```
[戏1] 上游一个字不吐然后装死（300ms 静默上限）…
  [retry] 第 1 次失败（stream_idle_timeout），约 83ms 后重试
[戏1] 看门狗 + 重试救回来了 → 一切正常，任务完成。

[戏2] 上游连续限流（429，要求 400ms 后再来）…
  [retry] 第 1 次失败（http），约 458ms 后重试
  [retry] 第 2 次失败（http），约 368ms 后重试
[戏2] 退避重试救回来了 → 一切正常，任务完成。

[戏3] 上游吐了半句才断线…
这半句已经上屏了，
[戏3] 已上屏 → 拒绝重试（否则重复显示、重复计费）→ 正文读到一半连接被掐断
```

三出戏正好把本章的三条规矩各演一遍：戏 1 是「两道计时」里的正文看门狗（SDK 的连接超时管不到它），戏 2 是「退避与 Retry-After 取大」（退避算出 80/160ms，但服务端要求 400ms，听服务端的），戏 3 是「已外发正文绝不重试」——注意戏 3 的错误本身是可重试的 `network`，但被「已上屏」这条铁律拦下，两套规则叠加才是完整行为。把 `flaky-model` 换成真实流式实现，这层壳原封不动。

## 6. 小结与下一章

模型层的可靠，不是「加个 try/catch」就完事，而是把**连接/正文两道时限、可识别的静默超时、自己可控的退避、以及「已上屏的字绝不重来」**这几条铁律焊进壳里，每条都靠源码注释里的真实事故兜底。

但还有一类故障模型层管不了：模型说「`rm -rf build`」并且真的要去执行。下一章（安全模型）讲**审批三档、风险分级、路径与凭据保护**——以及那条贯穿整个安全设计的核心原则：**「路径守卫只是尽力而为，审批才是真正的防线」。**
