import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");
const WEBHOOK = process.env.FEISHU_WEBHOOK_URL;
if (!WEBHOOK) { console.error("请设置 FEISHU_WEBHOOK_URL"); process.exit(1); }

function todayStr() { return new Date().toISOString().slice(0, 10); }

function formatDateCN(d) { return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; }

function esc(t) {
  return t.replace(/\*/g, "\\*").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
          .replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\</g, "\\<").replace(/\>/g, "\\>");
}

function parseReport(raw) {
  const lines = raw.split("\n");
  const articles = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^- (\d{2}:\d{2}|时间未知) \| \*\*\[(.+?)\]\((.+?)\)\*\*$/);
    if (!m) { i++; continue; }
    const time = m[1], titleCN = m[2], link = m[3];
    let titleEN = "";
    if (i + 1 < lines.length) {
      const en = lines[i + 1].match(/^\s*\*\s*(.+?)\s*\*\s*$/);
      if (en) { titleEN = en[1]; i++; }
    }
    let summaryCN = "", summaryEN = "";
    while (i + 1 < lines.length && lines[i + 1].startsWith("> ")) {
      i++;
      const q = lines[i].slice(2);
      if (q.startsWith("🇨🇳 ")) summaryCN = q.slice(3);
      else if (q.startsWith("🇺🇸 ")) summaryEN = q.slice(3);
    }
    articles.push({ time, titleCN, titleEN, link, summaryCN, summaryEN });
    i++;
  }
  return { articles, count: articles.length };
}

function buildCard(articles, count) {
  const now = new Date();
  const elements = [{
    tag: "div",
    text: { tag: "lark_md", content: `**📅 日期**：${formatDateCN(now)}　**🕘 更新**：${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" })}　**📊 共 ${count} 篇**` }
  }, { tag: "hr" }];

  let bytes = JSON.stringify(elements).length;
  const MAX = 28000;
  for (const a of articles) {
    let block = `**${esc(a.titleCN)}**\n*${esc(a.titleEN)}*\n`;
    if (a.summaryCN) block += `🇨🇳 ${esc(a.summaryCN)}\n`;
    if (a.summaryEN) block += `🇺🇸 ${esc(a.summaryEN)}\n`;
    block += `[链接](${a.link})`;
    const el = { tag: "div", text: { tag: "lark_md", content: block } };
    if (bytes + JSON.stringify(el).length > MAX) {
      elements.push({ tag: "div", text: { tag: "lark_md", content: "（内容过长已截断）" } });
      break;
    }
    elements.push(el);
    bytes += JSON.stringify(el).length;
  }
  return { msg_type: "interactive", card: { header: { title: { tag: "plain_text", content: `🤖 AI 新闻日报 - ${formatDateCN(now)}` }, template: "indigo" }, elements } };
}

function main() {
  const raw = readFileSync(join(OUTPUT_DIR, `ai-news-${todayStr()}.md`), "utf-8");
  const { articles, count } = parseReport(raw);
  if (articles.length === 0) { console.error("无文章"); process.exit(1); }
  fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildCard(articles, count)) })
    .then((r) => r.json())
    .then((d) => {
      if (d.StatusCode === 0 || d.StatusMessage === "success") console.log("飞书卡片发送成功");
      else { console.error("飞书发送失败:", JSON.stringify(d)); process.exit(1); }
    })
    .catch((e) => { console.error("发送失败:", e.message); process.exit(1); });
}

main();