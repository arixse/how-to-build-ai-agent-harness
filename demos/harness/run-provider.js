// harness/run-provider.js —— 第5章 demo：四出戏
// 戏1 同一接口、两家不同的请求组装（鉴权头 / URL）  戏2 窗口推断（最长前缀 + 供应商覆盖 + 兜底）
// 戏3 三级解析（显式配置 > 推断 > 兜底）  戏4 自定义供应商的底线；连回第4章的压缩阈值

import {
  createProviderService, createOpenAIProvider, createAnthropicProvider, createCustomProvider,
  assertCustomProviderName,
} from "./provider.js";
import { resolveContextWindow, matchContextWindowRule } from "./context-window.js";
import { resolveContextBudget } from "./context.js";

// ---------- 戏 1：一个接口，各家差异全在实现里 ----------
{
  const service = createProviderService();
  service.register(createOpenAIProvider());
  service.register(createAnthropicProvider());
  const oa = service.get("openai").buildModelRequest("sk-demo");
  const an = service.get("anthropic").buildModelRequest("sk-ant-demo");
  console.log("【戏1】openai    →", oa.url);
  console.log("        headers =", JSON.stringify(oa.headers));
  console.log("【戏1】anthropic →", an.url, "（Base URL 不带 /v1，模型列表要显式 /v1/models）");
  console.log("        headers =", JSON.stringify(an.headers));
  console.log("【戏1】注册中心里的供应商 =", service.names().join(", "), "—— 新增一家不用改调用方");
}

// ---------- 戏 2：窗口推断（最长前缀优先 + 供应商覆盖 + 兜底） ----------
{
  console.log("\n【戏2】gpt-4o-2024-08-06 →", matchContextWindowRule("gpt-4o-2024-08-06")?.window, "（gpt-4o 赢过 gpt-4：最长前缀优先）");
  console.log("【戏2】gpt-4             →", matchContextWindowRule("gpt-4")?.window, "（裸 gpt-4 是 8k，最容易踩坑）");
  console.log("【戏2】gpt-5.3-codex-spark →", matchContextWindowRule("gpt-5.3-codex-spark")?.window, "（128K 而非 gpt-5 的 400K，否则超窗 400）");
  console.log("【戏2】minimax-m3 @bailian →", matchContextWindowRule("minimax-m3", "bailian")?.window, "（百炼代销 192K；原厂 1M）");
  console.log("【戏2】minimax-m3（原厂）  →", matchContextWindowRule("minimax-m3", "minimax")?.window ?? "（表里未登记 → 兜底）");
  const unknown = resolveContextWindow({ modelName: "some-brand-new-model" });
  console.log("【戏2】some-brand-new-model →", unknown.window, `（认不出 → 兜底 ${unknown.source}；估大 400、估小只是多压几次，宁可保守）`);
}

// ---------- 戏 3：三级解析：显式配置 > 推断 > 兜底 ----------
{
  console.log("\n【戏3】显式配置 32000 →", JSON.stringify(resolveContextWindow({ configured: 32000, modelName: "gpt-6" })));
  console.log("【戏3】只给模型名    →", JSON.stringify(resolveContextWindow({ modelName: "gpt-6" })));
  console.log("【戏3】什么都没有    →", JSON.stringify(resolveContextWindow({})));
}

// ---------- 戏 4：自定义供应商的底线 + 连回第 4 章 ----------
{
  console.log("\n【戏4】自定义供应商（OpenAI 兼容网关）注册成功：", createCustomProvider("my-gateway", "https://my-gw.example/v1").getBaseUrl());
  for (const bad of ["", "a/b/c", "x".repeat(65)]) {
    try { assertCustomProviderName(bad); } catch (e) { console.log("【戏4】拒绝非法名字：", e.message); }
  }
  // 压缩阈值（第4章 resolveContextBudget）的原料就是这里的窗口：
  const gpt4 = resolveContextWindow({ modelName: "gpt-4" }).window; // 8192
  const gpt6 = resolveContextWindow({ modelName: "gpt-6" }).window; // 1050000
  console.log("【戏4】gpt-4（8k）的压缩阈值 =", resolveContextBudget(gpt4), "token（被下限 8000 托底）");
  console.log("【戏4】gpt-6（1.05M）的压缩阈值 =", resolveContextBudget(gpt6), "token（8000 下限只为小窗口防每轮都压）");
}
