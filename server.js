/**
 * 河吶山 LINE Bot — 教練 / 美編訊息自動分類與轉發
 *
 * 運作方式：
 * 1. 教練或美編在 LINE 傳訊息給河吶山官方帳號
 * 2. Bot 依關鍵字判斷是「教練類」還是「美編類」訊息
 * 3. Bot 在原對話裡回覆一句確認收到的話
 * 4. Bot 同時把整理好的訊息（含分類標籤、寄件者、內容）推送給 Leo 的 LINE，
 *    Leo 就不用一直在中間轉傳，但還是能看到所有往來訊息
 *
 * 這是 MVP 版本：分類用關鍵字比對，先求穩定可用。
 * 之後如果想要更聰明的分類（例如語意理解），可以把 classify() 換成呼叫 Claude API。
 */

const express = require("express");
const line = require("@line/bot-sdk");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// Leo 自己的 LINE 使用者 ID，Bot 會把分類好的訊息推送到這裡
// 取得方式見 README「如何取得你自己的 User ID」
const LEO_USER_ID = process.env.LEO_USER_ID;

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

// ---- 分類規則（可自行增減關鍵字） ----
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

function classify(text) {
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return rule;
    }
  }
  return { name: "其他", emoji: "💬" };
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
  const category = classify(text);
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
      `內容：${text}`;

    await client.pushMessage({
      to: LEO_USER_ID,
      messages: [{ type: "text", text: summary }],
    });
  }

  return null;
}

// 路徑跟 Leo 在 LINE 官方帳號後台已經填好的 Webhook 網址一致
// （https://.../webhook/line-agent），這樣部署新版程式時就不用再去改 LINE 那邊的設定
app.post(
  "/webhook/line-agent",
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
