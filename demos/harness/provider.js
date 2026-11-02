// harness/provider.js —— 第5章：统一 Provider 接口（鉴权头 / Base URL / 模型列表差异全沉在实现里）
// 裁自 mini-pi packages/core/src/provider/{index,openai,anthropic,custom}.ts（简化：request 组装为纯函数，便于 demo 零网络演示）

/** 默认的模型列表地址：去掉结尾斜杠后拼 /models（对齐 index.ts buildModelsUrl） */
export function buildModelsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/**
 * 自定义供应商名的底线（对齐 index.ts assertCustomProviderName）：
 * "/" 是 settings 里「供应商/模型」的分隔符，名字里带它会把默认模型解析撕成三段。
 */
export function assertCustomProviderName(name) {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("自定义供应商名不能为空");
  if (trimmed.includes("/")) throw new Error(`自定义供应商名不能包含 "/"：${name}`);
  if (trimmed.length > 64) throw new Error("自定义供应商名太长（上限 64 个字符）");
}

// ---------- 每家一个实现文件：差异只出现在这里 ----------

/** OpenAI：Base URL 自带 /v1，模型列表与请求同源；鉴权用 Authorization: Bearer */
export function createOpenAIProvider({ baseUrl = "https://api.openai.com/v1" } = {}) {
  return {
    getProviderName: () => "openai",
    getSdkType: () => "OpenAI",
    getBaseUrl: () => baseUrl,
    getModelsUrl: (base) => buildModelsUrl(base),
    buildModelRequest: (apiKey) => ({
      url: buildModelsUrl(baseUrl),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    }),
  };
}

/**
 * Anthropic：与 OpenAI 兼容家有三点不同（对齐 anthropic.ts 头注释）：
 * 1. 鉴权头是 x-api-key + anthropic-version，不是 Bearer；
 * 2. Base URL 不带 /v1（SDK 请求 messages 时自己拼），模型列表要显式 /v1/models——直接拼 /models 会 404；
 * 3. 多一个 anthropic-version 版本头。
 */
export function createAnthropicProvider({ baseUrl = "https://api.anthropic.com" } = {}) {
  const ANTHROPIC_VERSION = "2023-06-01";
  return {
    getProviderName: () => "anthropic",
    getSdkType: () => "Anthropic",
    getBaseUrl: () => baseUrl,
    getModelsUrl: (base) => `${base.replace(/\/+$/, "")}/v1/models`,
    buildModelRequest: (apiKey) => ({
      url: `${baseUrl.replace(/\/+$/, "")}/v1/models`,
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "Content-Type": "application/json" },
    }),
  };
}

/** 自定义供应商：协议固定 OpenAI 兼容（自建网关的事实标准），名称与 Base URL 由用户给，凭据独立存放 */
export function createCustomProvider(name, baseUrl) {
  assertCustomProviderName(name);
  return {
    getProviderName: () => name,
    getSdkType: () => "OpenAI",
    getBaseUrl: () => baseUrl,
    getModelsUrl: (base) => buildModelsUrl(base),
    buildModelRequest: (apiKey) => ({
      url: buildModelsUrl(baseUrl),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    }),
    getDefaultModels: () => [], // 没有内置名单就是没有，不编几个充数
  };
}

/** 注册中心：新增一家 = 写一个实现文件 + 注册进这张 Map，调用方一行不改（对齐 index.ts ModelProviderService） */
export function createProviderService() {
  const providers = new Map();
  return {
    register(provider) { providers.set(provider.getProviderName(), provider); },
    get(name) { return providers.get(name) ?? null; },
    names: () => [...providers.keys()],
  };
}
