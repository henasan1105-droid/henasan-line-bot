/**
 * 河吶山 LINE Bot — 教練 / 美編訊息自動分類與轉發
 *
 * 運作方式：
 * 1. 教練或美編在 LINE 傳訊息給河吶山官方帳號
 * 2. Bot 用 AI（Claude）判斷這句話是「教練類」還是「美編類」，並整理出一句重點摘要
 *    （如果 AI 呼叫失敗，會自動退回用關鍵字比對，確保 Bot 還是能正常運作）
 * 3. Bot 在原對話裡回覆一句確認收到的話
 * 4. Bot 同時把整理好的訊息（含分類標籤、寄件者、重點摘要、原文）推送給 Leo 的 LINE，
 *    Leo 就不用一直在中間轉傳，但還是能看到所有往來訊息
 *
 * 2026-08-12 更新：分類邏輯從純關鍵字比對，升級為呼叫 Claude API 做語意判斷，
 * 準確度更高，也會順便幫忙抓出訊息重點。關鍵字比對保留作為備援方案。
 */

const express = require("express");
const line = require("@line/bot-sdk");
const Anthropic = require("@anthropic-ai/sdk");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// Leo 自己的 LINE 使用者 ID，Bot 會把分類好的訊息推送到這裡
// 取得方式見 README「如何取得你自己的 User ID」
const LEO_USER_ID = process.env.LEO_USER_ID;

// Claude API 金鑰，用來做語意分類。沒有設定的話會自動退回關鍵字比對。
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

// 除錯用：把每個進來的請求方法跟路徑印出來，方便在 Render 的 Logs 頁面確認
// LINE 平台的請求有沒有真的送到這支程式
app.use((req, res, next) => {
  console.log(`[incoming] ${req.method} ${req.path}`);
  next();
});

// ---- 關鍵字備援規則（AI 分類失敗時才會用到，可自行增減關鍵字） ----
const CATEGORY_RULES = [
  {
    name: "教練類",
    emoji: "🥊",
    keywords: [
      "課表", "代課", "請假", "學生", "上課", "訓練", "招生",
      "課程", "教學", "場地", "器材", "報名", "體驗課", "會員",
    ],
  },
  {
    name: "美編類",
    emoji: "🎨",
    keywords: [
      "圖", "設計", "排版", "文案", "貼文", "IG", "輪播", "封面",
      "素材", "尺寸", "修圖", "印刷", "海報", "版型", "字體",
    ],
  },
];

const EMOJI_MAP = {
  教練類: "🥊",
  美編類: "🎨",
  其他: "💬",
};

// ---- 關鍵字比對（備援用） ----
function classifyByKeyword(text) {
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return { category: rule.name, summary: text.slice(0, 15) };
    }
  }
  return { category: "其他", summary: text.slice(0, 15) };
}

// ---- AI 語意分類：判斷類別 + 整理一句重點摘要 ----
async function classifyWithAI(text) {
  if (!anthropic) return null;

  const prompt = `你是河吶山運動工作室的訊息分類助手。請判斷以下訊息屬於：
「教練類」（跟課程、學生、代課、請假、場地、器材、招生、上課安排有關）
「美編類」（跟設計、文案、貼文、IG、輪播圖、素材、排版有關）
或「其他」（以上都不是，例如閒聊、測試訊息）。

同時用一句話（15字以內）整理這則訊息的重點，讓 Leo 一看就懂在講什麼。

訊息內容：「${text}」

只回傳這個格式的 JSON，不要加任何其他文字或說明：
{"category": "教練類 或 美編類 或 其他", "summary": "重點摘要"}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].text.trim();
    // 避免 AI 偶爾多包一層 markdown code block，先去掉
    const cleaned = raw.replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned);

    if (!["教練類", "美編類", "其他"].includes(parsed.category)) {
      throw new Error(`AI 回傳了不在預期內的分類：${parsed.category}`);
    }

    return parsed;
  } catch (e) {
    console.error("[AI 分類失敗，改用關鍵字備援]", e.message || e);
    return null;
  }
}

async function classify(text) {
  const aiResult = await classifyWithAI(text);
  const result = aiResult || classifyByKeyword(text);
  const emoji = EMOJI_MAP[result.category] || "💬";
  return { name: result.category, emoji, summary: result.summary };
}

// ---- 取得訊息寄件者的顯示名稱 ----
async function getSenderName(event) {
  try {
    if (event.source.type === "user") {
      const profile = await client.getProfile(event.source.userId);
      return profile.displayName;
    }
    if (event.source.type === "group") {
      const profile = await client.getGroupMemberProfile(
        event.source.groupId,
        event.source.userId
      );
      return profile.displayName;
    }
  } catch (e) {
    console.error("無法取得寄件者名稱", e);
  }
  return "未知使用者";
}

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const text = event.message.text;
  const category = await classify(text);
  const senderName = await getSenderName(event);

  // 1. 在原對話裡回覆確認收到
  const replyText =
    category.name === "其他"
      ? "已收到你的訊息，Leo 會盡快回覆！"
      : `已收到（${category.emoji} ${category.name}），會盡快處理～`;

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: replyText }],
  });

  // 2. 推送整理好的訊息給 Leo
  if (LEO_USER_ID) {
    const summary =
      `${category.emoji} ${category.name}\n` +
      `來自：${senderName}\n` +
      `重點：${category.summary}\n` +
      `原文：${text}`;

    await client.pushMessage({
      to: LEO_USER_ID,
      messages: [{ type: "text", text: summary }],
    });
  }

  return null;
}

app.post(
  "/webhook",
  line.middleware(config),
  async (req, res) => {
    try {
      await Promise.all(req.body.events.map(handleEvent));
      res.status(200).end();
    } catch (err) {
      console.error(err);
      res.status(500).end();
    }
  }
);

// 健康檢查用，部署平台常會 ping 這個路徑確認服務還活著
app.get("/", (req, res) => {
  res.send("河吶山 LINE Bot 運作中");
});

// 除錯用：如果請求沒有對到任何路由，印出來方便判斷是不是網址/路徑打錯
app.use((req, res) => {
  console.log(`[404] no route matched for ${req.method} ${req.path}`);
  res.status(404).send("Not found");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
