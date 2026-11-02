// harness/skills.js —— 第7章：Skill 加载器（渐进式披露）
// 裁自 mini-pi packages/core/src/agent/skillLoader.ts（简化：目录列表由调用方给）。
// 渐进式披露：系统提示里只有元数据清单（名称+描述），全文由模型经 load_skill 工具按需取用——
// 每次请求的固定开销就只有那一份清单，而不是所有 skill 的全文。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 从 SKILL.md 解析 frontmatter（--- 包裹的 name/description） */
export function parseFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return null;
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  if (!name || !description) return null; // 没有 name 就无法按需加载
  return { name, description };
}

export function createSkillLoader(dirs) {
  // 同名 skill 后加载者覆盖先加载者：目录列表按优先级从低到高排列
  let metadataCache = null;
  const contentCache = new Map();

  function scanSkillDir(dirPath) {
    if (!existsSync(dirPath)) return [];
    const results = [];
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(dirPath, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const content = readFileSync(skillFile, "utf8");
      const meta = parseFrontmatter(content);
      if (meta) results.push({ ...meta, skillFile });
      // 解析失败必须告警：静默跳过会让「写了 skill 却列表里没有」变成玄学问题
      else console.warn(`跳过无法解析的 skill：${skillFile}（缺少 name/description 字段）`);
    }
    return results;
  }

  function loadAllMetadata() {
    if (metadataCache) return [...metadataCache];
    const byName = new Map();
    for (const dir of dirs) for (const s of scanSkillDir(dir)) byName.set(s.name, s);
    metadataCache = [...byName.values()];
    return [...metadataCache];
  }

  function loadSkill(skillName) {
    if (contentCache.has(skillName)) return contentCache.get(skillName);
    const meta = loadAllMetadata().find((s) => s.name === skillName);
    if (!meta) return null;
    const skill = { ...meta, content: readFileSync(meta.skillFile, "utf8") };
    contentCache.set(skillName, skill);
    return skill;
  }

  /** 注入 system prompt 的清单：只有元数据，没有全文 */
  function generateSkillSummary() {
    const metadata = loadAllMetadata();
    if (metadata.length === 0) return "";
    const lines = ["## 可用 Skills", "", "当用户的请求与某个 skill 相关时，调用 load_skill 工具加载它的完整内容再执行；不要询问用户，直接加载。", ""];
    for (const s of metadata) lines.push(`- **${s.name}**: ${s.description}`);
    return lines.join("\n");
  }

  return { loadAllMetadata, loadSkill, generateSkillSummary };
}

/** load_skill 工具：渐进式披露的另一半——全文按需取用 */
export function createLoadSkillTool(loader) {
  return {
    name: "load_skill",
    description: "按名称加载一个 skill 的完整内容",
    concurrent: true, // 只读
    run: ({ name }) => {
      const skill = loader.loadSkill(name);
      if (!skill) return { text: `未找到 skill：${name}`, isError: true };
      return { text: skill.content };
    },
  };
}
