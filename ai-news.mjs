import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");

const FEEDS = [
  { name: "TechCrunch", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "The Verge",  url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { name: "Hacker News", url: "https://hnrss.org/newest?q=AI&count=30" },
];

// ── Helpers ──────────────────────────────────────────────────────────

function formatTime(date) {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "").trim();
}

function cleanDescription(raw, source) {
  let text = raw;
  if (source === "Hacker News") {
    text = text
      .replace(/^Article URL:\s*https?:\/\/\S+\s*/i, "")
      .replace(/^Comments URL:\s*https?:\/\/\S+\s*/i, "")
      .replace(/^Points:\s*\d+\s*/i, "")
      .replace(/# of Comments:\s*\d+\s*/i, "")
      .trim();
  }
  return text ? text.slice(0, 800) : "";
}

// ── Fetch ────────────────────────────────────────────────────────────

const parser = new Parser({ timeout: 15_000, headers: { "User-Agent": "ai-news-digest/1.0" } });

async function fetchFeed(config) {
  console.log(`  抓取 ${config.name}...`);
  const feed = await parser.parseURL(config.url);
  return (feed.items ?? []).map((item) => {
    const descRaw = item.contentSnippet ?? item.content ?? item.summary ?? "";
    return {
      title: item.title?.trim() ?? "(无标题)",
      link: item.link ?? "",
      pubDate: item.pubDate ? new Date(item.pubDate) : new Date(0),
      source: config.name,
      description: cleanDescription(stripHtml(descRaw), config.name),
    };
  });
}

// ── Filter & Dedup ───────────────────────────────────────────────────

function filterLast24Hours(articles) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return articles.filter((a) => a.pubDate.getTime() >= cutoff);
}

function dedupByUrl(articles) {
  const seen = new Set();
  return articles.filter((a) => { if (seen.has(a.link)) return false; seen.add(a.link); return true; });
}

// ── Claude: bilingual ─────────────────────────────────────────────────

function buildClaudePrompt(articles) {
  const items = articles.map((a, i) => `[${i}] 标题: ${a.title}\n描述: ${a.description || "(无)"}\n`);
  return `对每篇文章完成三项任务：
1. 标题翻译成简中（≤30字）
2. 用简中写一句摘要（≤60字）
3. 用英文写一句摘要（≤60 words）

只输出 JSON 行，每行一条：
{"i":序号,"t":"中文标题","s_cn":"中文摘要","s_en":"English summary"}

注意：JSON 值中不要出现英文双引号，用「」代替；不要输出其他内容。

${items.join("\n")}`;
}

async function enrichBatch(anthropic, model, articles) {
  if (articles.length === 0) return [];
  console.log(`    处理 ${articles.length} 篇...`);
  try {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: 'You are a bilingual tech news editor. Output one JSON object per line, no array. Format: {"i":N,"t":"简中标题","s_cn":"简中摘要","s_en":"English summary"}. Do not use double quotes inside values — use guillemets「」instead. Output nothing else.',
      messages: [{ role: "user", content: buildClaudePrompt(articles) }],
    });
    const text = msg.content[0].text;
    const resultMap = new Map();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.i === undefined || !obj.t) continue;
        resultMap.set(obj.i, { title_cn: obj.t, summary_cn: obj.s_cn ?? "", summary_en: obj.s_en ?? "" });
      } catch {
        const t = trimmed.match(/"t"\s*:\s*"([^"]*)"/);
        const sc = trimmed.match(/"s_cn"\s*:\s*"([^"]*)"/);
        const se = trimmed.match(/"s_en"\s*:\s*"([^"]*)"/);
        const idx = trimmed.match(/"i"\s*:\s*(\d+)/);
        if (t && idx) resultMap.set(parseInt(idx[1]), { title_cn: t[1], summary_cn: sc?.[1] ?? "", summary_en: se?.[1] ?? "" });
      }
    }
    return articles.map((a, i) => ({
      ...a,
      titleCN: resultMap.get(i)?.title_cn ?? a.title,
      summaryCN: resultMap.get(i)?.summary_cn ?? a.description.slice(0, 80),
      summaryEN: resultMap.get(i)?.summary_en ?? a.description.slice(0, 120),
    }));
  } catch (err) {
    console.warn(`    ⚠ 批次失败: ${err.message ?? err}，回退`);
    return articles.map((a) => ({ ...a, titleCN: a.title, summaryCN: a.description.slice(0, 80), summaryEN: a.description.slice(0, 120) }));
  }
}

async function enrichWithClaude(articles) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) {
    console.warn("  ⚠ 未设置 API key，跳过 AI 翻译/摘要");
    return articles.map((a) => ({ ...a, titleCN: a.title, summaryCN: a.description.slice(0, 80), summaryEN: a.description.slice(0, 120) }));
  }
  const anthropic = new Anthropic({ apiKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250501";
  console.log(`  调用 Claude (${model}) 处理 ${articles.length} 篇文章...`);
  const results = [];
  for (let i = 0; i < articles.length; i += 10) {
    results.push(...(await enrichBatch(anthropic, model, articles.slice(i, i + 10))));
  }
  return results;
}

function sortByTimeDesc(articles) {
  return articles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
}

// ── Render ──────────────────────────────────────────────────────────

function renderMarkdown(articles) {
  const now = new Date();
  const dateStr = formatDate(now);
  const bySource = new Map();
  for (const a of articles) {
    const list = bySource.get(a.source) ?? [];
    list.push(a);
    bySource.set(a.source, list);
  }
  const lines = [`# AI 新闻日报 - ${dateStr}`, "", `> 共 ${articles.length} 篇文章，更新时间：${formatTime(now)}`, ""];
  for (const feed of FEEDS) {
    const list = bySource.get(feed.name);
    if (!list || list.length === 0) continue;
    lines.push(`## ${feed.name}（${list.length} 篇）`, "");
    for (const a of list) {
      const time = a.pubDate.getTime() === 0 ? "时间未知" : formatTime(a.pubDate);
      lines.push(`- ${time} | **[${a.titleCN}](${a.link})**`);
      lines.push(`  *${a.title}*`);
      if (a.summaryCN || a.summaryEN) {
        lines.push(`  > 🇨🇳 ${a.summaryCN}`);
        lines.push(`  > 🇺🇸 ${a.summaryEN}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("AI 新闻聚合工具\n");
  const results = await Promise.allSettled(FEEDS.map((cfg) => fetchFeed(cfg)));
  const all = [];
  let failures = 0;
  for (let i = 0; i < FEEDS.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") all.push(...r.value);
    else { failures++; console.warn(`  ⚠ ${FEEDS[i].name} 抓取失败: ${r.reason?.message ?? r.reason}`); }
  }
  if (failures === FEEDS.length) { console.error("所有源抓取失败"); process.exit(1); }
  const before = all.length;
  const deduped = dedupByUrl(all);
  console.log(`  去重: ${before} → ${deduped.length}（删除 ${before - deduped.length} 篇）`);
  const recent = filterLast24Hours(deduped);
  console.log(`  近24小时: ${recent.length} 篇`);
  const enriched = await enrichWithClaude(recent);
  const sorted = sortByTimeDesc(enriched);
  const md = renderMarkdown(sorted);
  const filename = `ai-news-${formatDate(new Date())}.md`;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, filename), md, "utf-8");
  console.log(`\n  已输出到 output/${filename}`);
}

main().catch((err) => { console.error("运行失败:", err.message); process.exit(1); });