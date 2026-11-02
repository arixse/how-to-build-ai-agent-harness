// harness/model-reliable.js —— 第3章：给任意模型包上「可靠性壳」
// 真实常量来自 material 源码 packages/core/src/agent/model/config.ts 与 retry.ts：
//   REQUEST_TIMEOUT_MS = 120_000 / STREAM_IDLE_TIMEOUT_MS = 120_000（两道独立计时）
//   MAX_REQUEST_ATTEMPTS = 3（含首次）/ RETRY_BASE_DELAY_MS = 1_000 / RETRY_JITTER_RATIO = 0.2
// demo 里把时长调小（见 run-reliable.js），方便肉眼看着触发。

export const STREAM_IDLE_TIMEOUT_MS = 120_000; // 源码：config.ts —— 正文静默上限
export const MAX_REQUEST_ATTEMPTS = 3;         // 源码：retry.ts —— 最多尝试 3 次（含首次）
export const RETRY_BASE_DELAY_MS = 1_000;      // 源码：retry.ts —— 首次退避 1s，之后 ×2
export const RETRY_JITTER_RATIO = 0.2;         // 源码：retry.ts —— ±20% 抖动

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => { clearTimeout(t); reject(new Error("等待重试时被用户取消")); },
      { once: true },
    );
  });

// 单次尝试：包一道「静默看门狗」。
// 它与 SDK 的连接超时是两道独立计时——SDK 只管到「拿到响应头」，
// 这里管的是「正文阶段两段数据之间隔了多久」。只要有数据就重置计时。
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

    inner
      .complete({
        ...args,
        signal: attemptAc.signal,
        onDelta: (t) => { bump(); args.onDelta?.(t); }, // 有数据 → 重置计时
      })
      .then(
        (v) => { clearTimeout(timer); args.signal?.removeEventListener("abort", onOuterAbort); resolve(v); },
        (e) => { clearTimeout(timer); args.signal?.removeEventListener("abort", onOuterAbort); reject(e); },
      );
  });
}

function isRetryable(e) {
  if (e?.kind === "stream_idle_timeout") return true;             // 看门狗：上游装死
  if (e?.kind === "http") return e.status === 429 || e.status >= 500; // 限流 / 服务端错
  if (e?.kind === "network") return true;                          // 网络抖动 / 读一半被掐
  return false;                                                    // 其余（编程错误等）不重试
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
