#!/usr/bin/env node
// scripts/check-refs.mjs
//
// 校验 articles/ 中的 <!-- code-ref: <path>#L<start>-L<end> --> 标记，
// 在素材仓库（默认 material/mini-pi）当前文件上是否仍然有效：
//   1. 引用文件存在；
//   2. 起止行号未越界（1 <= start <= end <= 文件总行数）；
//   3. 单次引用不超过 60 行（AGENTS.md §4）。
//
// 素材是外部克隆，本地路径 material/mini-pi；CI 需先拉取素材。
// 可用环境变量 MATERIAL_ROOT 或命令行参数覆盖素材根。
//
// 用法:
//   node scripts/check-refs.mjs
//   MATERIAL_ROOT=/path/to/mini-pi node scripts/check-refs.mjs

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MATERIAL_ROOT =
  process.env.MATERIAL_ROOT ||
  (process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, "material", "mini-pi"));

const MAX_REF_LINES = 60;
const REF_RE = /<!--\s*code-ref:\s*([^\s#]+)#L(\d+)(?:-L(\d+))?\s*-->/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith(".md")) out.push(full);
  }
  return out;
}

function main() {
  if (!existsSync(MATERIAL_ROOT)) {
    console.error(`[check-refs] 素材根不存在: ${MATERIAL_ROOT}`);
    console.error(`[check-refs] 请先拉取素材仓库，或用 MATERIAL_ROOT 指定。`);
    process.exit(2);
  }

  const articleFiles = walk(resolve(ROOT, "articles"));
  let total = 0;
  let failures = 0;

  for (const file of articleFiles) {
    const text = readFileSync(file, "utf8");
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(text)) !== null) {
      total += 1;
      const [, relPath, startStr, endStr] = m;
      const start = Number(startStr);
      const end = endStr ? Number(endStr) : start;
      const target = join(MATERIAL_ROOT, relPath);
      const tag = `${relPath}#L${start}${endStr ? `-L${end}` : ""}`;

      if (!existsSync(target)) {
        console.error(`[FAIL] ${file}\n       文件不存在: ${tag}`);
        failures += 1;
        continue;
      }
      const lineCount = readFileSync(target, "utf8").split("\n").length;
      if (start < 1 || end < start || end > lineCount) {
        console.error(
          `[FAIL] ${file}\n       行号越界: ${tag} (文件共 ${lineCount} 行)`,
        );
        failures += 1;
        continue;
      }
      if (end - start + 1 > MAX_REF_LINES) {
        console.error(
          `[WARN] ${file}\n       引用超过 60 行: ${tag} (${end - start + 1} 行)`,
        );
      }
    }
  }

  console.log(
    `[check-refs] 共校验 ${total} 处 code-ref，素材根: ${MATERIAL_ROOT}`,
  );
  if (failures > 0) {
    console.error(`[check-refs] 失败 ${failures} 处，请修文章，不要删校验。`);
    process.exit(1);
  }
  console.log(`[check-refs] 全部有效 ✓`);
}

main();
