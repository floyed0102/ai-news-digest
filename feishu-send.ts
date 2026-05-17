import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");
const WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL;

if (!WEBHOOK_URL) {
  console.error("请设置环境变量 FEISHU_WEBHOOK_URL");
  process.exit(1);
}

// ── Types ──────────────────────────────────────────────────────────

interface CardHeader {
  title: { tag: "plain_text"; content: string };
  template: string;
}

interface CardElement {
  tag: "div" | "hr";
  text?: { tag: "lark_md"; content: string };
}

interface FeishuCardMessage {
  msg_type: "interactive";
  card: {
    header: CardHeader;
    elements: CardElement[];
  };
}

interface ParsedArticle {
  time: string;
  titleCN: string;
  titleEN: string;
  link: string;
  summaryCN: string;
  summaryEN: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDateCN(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function escapeMd(text: string): string {
  // Escape characters that Lark Markdown treats specially
  return text
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\</g, "\\<")
    .replace(/\>/g, "\\>");
}

/** Parse the Markdown report into typed article objects */
function parseReport(raw: string): {
  articles: ParsedArticle[];
  articleCount: number;
} {
  const lines = raw.split("\n");
  const articles: ParsedArticle[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Match article line: "- HH:MM | **[中文标题](url)**"
    const articleMatch = line.match(
      /^- (\d{2}:\d{2}|时间未知) \| \*\*\[(.+?)\]\((.+?)\)\*\*$/
    );
    if (!articleMatch) {
      i++;
      continue;
    }

    const time = articleMatch[1];
    const titleCN = articleMatch[2];
    const link = articleMatch[3];

    // Next line: "*English title*"
    let titleEN = "";
    if (i + 1 < lines.length) {
      const enMatch = lines[i + 1].match(/^\s*\*\s*(.+?)\s*\*\s*$/);
      if (enMatch) {
        titleEN = enMatch[1];
        i++;
      }
    }

    // Next lines: "> 🇨🇳 ..." and "> 🇺🇸 ..."
    let summaryCN = "";
    let summaryEN = "";
    while (i + 1 < lines.length && lines[i + 1].startsWith("> ")) {
      i++;
      const quoteLine = lines[i].slice(2);
      if (quoteLine.startsWith("🇨🇳 ")) {
        summaryCN = quoteLine.slice(3);
      } else if (quoteLine.startsWith("🇺🇸 ")) {
        summaryEN = quoteLine.slice(3);
      }
    }

    articles.push({ time, titleCN, titleEN, link, summaryCN, summaryEN });
    i++;
  }

  return { articles, articleCount: articles.length };
}

// ── Build Card ─────────────────────────────────────────────────────

function buildCard(
  articles: ParsedArticle[],
  articleCount: number
): FeishuCardMessage {
  const now = new Date();
  const elements: CardElement[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**📅 日期**：${formatDateCN(now)}　**🕘 更新**：${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" })}　**📊 共 ${articleCount} 篇**`,
      },
    },
    { tag: "hr" },
  ];

  // Respect Feishu card byte limit — roughly 30KB
  const MAX_BYTES = 28000;
  let currentBytes = JSON.stringify(elements).length;

  for (const a of articles) {
    let block = `**${escapeMd(a.titleCN)}**\n`;
    block += `*${escapeMd(a.titleEN)}*\n`;
    if (a.summaryCN) block += `🇨🇳 ${escapeMd(a.summaryCN)}\n`;
    if (a.summaryEN) block += `🇺🇸 ${escapeMd(a.summaryEN)}\n`;
    block += `[${escapeMd(a.link)}](${a.link})`;

    const el: CardElement = {
      tag: "div",
      text: { tag: "lark_md", content: block },
    };
    const elBytes = JSON.stringify(el).length;

    if (currentBytes + elBytes > MAX_BYTES) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: "（内容过长已截断，完整版请查看 GitHub）",
        },
      });
      break;
    }

    elements.push(el);
    currentBytes += elBytes;
  }

  return {
    msg_type: "interactive",
    card: {
      header: {
        title: {
          tag: "plain_text",
          content: `🤖 AI 新闻日报 - ${formatDateCN(now)}`,
        },
        template: "indigo",
      },
      elements,
    },
  };
}

// ── Main ───────────────────────────────────────────────────────────

function main() {
  const today = todayStr();
  const filepath = join(OUTPUT_DIR, `ai-news-${today}.md`);

  let raw: string;
  try {
    raw = readFileSync(filepath, "utf-8");
  } catch {
    console.error(`日报文件不存在: ai-news-${today}.md`);
    process.exit(1);
  }

  const { articles, articleCount } = parseReport(raw);

  if (articles.length === 0) {
    console.error("日报中无文章");
    process.exit(1);
  }

  const card = buildCard(articles, articleCount);

  fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  })
    .then((res) => res.json())
    .then((data) => {
      const resp = data as {
        StatusCode?: number;
        StatusMessage?: string;
        msg?: string;
      };
      if (resp.StatusCode === 0 || resp.StatusMessage === "success") {
        console.log("飞书卡片发送成功");
      } else {
        console.error("飞书发送失败:", JSON.stringify(resp));
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("发送请求失败:", err.message);
      process.exit(1);
    });
}

main();