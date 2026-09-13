import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const CF_ACCOUNT = (process.env.CF_ACCOUNT_ID || "").trim();
const CF_TOKEN = (process.env.CF_API_TOKEN || "").trim();
const PORT = process.env.PORT || 10000;

function normalizeMessages(msgs) {
  return (msgs || []).map(m => {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map(c => {
        if (typeof c === "string") return c;
        return c.text || c.content || "";
      }).join("\n");
    }
    if (typeof content !== "string") content = String(content || "");
    return { role: m.role || "user", content: content };
  }).filter(m => m.content);
}

app.get("/", (req, res) => res.send("V10 OK " + new Date().toISOString()));

app.get("/v1/models", (req, res) => {
  res.json({ object: "list", data: [
      { id: "@cf/meta/llama-3.1-8b-instruct-fast", object: "model", owned_by: "meta" },
      { id: "@cf/ibm-granite/granite-4.0-h-micro", object: "model", owned_by: "ibm" },
      { id: "@cf/black-forest-labs/flux-1-schnell", object: "model", owned_by: "black-forest" },
      { id: "@cf/black-forest-labs/flux-2-klein-4b", object: "model", owned_by: "black-forest" }
  ]});
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    let { model, messages, stream } = req.body;
    messages = normalizeMessages(messages);
    
    const isChatModel = model.includes("granite") || model.includes("llama") || model.includes("gemma");
    const cfUrl = isChatModel
      ? `https://cloudflare.com{CF_ACCOUNT}/ai/v1/chat/completions`
      : `https://cloudflare.com{CF_ACCOUNT}/ai/run/${model}`;

    const body = isChatModel ? { model, messages, stream: !!stream } : { messages };

    const cfRes = await fetch(cfUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!cfRes.ok) {
      const t = await cfRes.text();
      console.error("CF ERROR:", t);
      return res.status(cfRes.status).json({ error: { message: "AiError: " + t, type: "api_error", code: "cloudflare_api_error" } });
    }

    if (stream && isChatModel) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      const reader = cfRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      const reader = cfRes.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data:")) {
            try {
              const j = JSON.parse(line.slice(5));
              if (j.response) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: j.response } }] })}\n\n`);
            } catch { res.write(line + "\n\n"); }
          }
        }
      }
      res.write("data: [DONE]\n\n"); res.end();
    } else {
      const text = await cfRes.text();
      res.setHeader("Content-Type", "application/json");
      res.send(text);
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: { message: e.message } });
  }
});

// 🛠️ 徹底重構、修正 fetch 斷流、修復變性問題的生圖函式
async function handleImage(req, res) {
  try {
    const model = "@cf/black-forest-labs/flux-2-klein-4b";
    
    // 💡 1. 核心定錨提示詞：在最前面強加入女性限制，強制要求模型保留參考圖的五官
    const userPrompt = req.body.prompt || "changing clothes";
    const prompt = `A beautiful young woman, keeping the identical face and hair from image 0, ${userPrompt}. Realistic photography, masterpiece.`;
    
    const size = (req.body.size || "1024x1024").split("x");
    const width = String(parseInt(size[0]) || 1024);
    const height = String(parseInt(size[1]) || 1024);
    const imgInput = req.body.image || req.body.image_b64;

    // 💡 2. 使用 Node.js 20 內建的原生標準 FormData 物件
    const form = new globalThis.FormData();
    form.append("prompt", prompt);
    form.append("width", width);
    form.append("height", height);

    if (imgInput) {
      // 💡 3. 清理 Base64 字串並將其轉換成符合傳輸規格的標準 Blob
      const b64 = String(imgInput).includes(",") ? String(imgInput).split(",")[1] : String(imgInput);
      const buffer = Buffer.from(b64, "base64");
      
      // 💡 4. 使用標準 Blob 包裝，並且欄位名稱精確指定為官方要求的 input_image_0
      const blob = new Blob([buffer], { type: "image/jpeg" });
      form.append("input_image_0", blob, "input.jpg");
      
      // 💡 5. 設定較高的重繪強度 (0.8)，給予 AI 更換衣服與背景的空間，但留住臉部
      const strengthValue = String(req.body.strength || 0.8);
      form.append("strength", strengthValue);
      
      console.log(`[Proxy Image] 圖片成功打包為 Blob。大小: ${buffer.length} 位元組，重繪強度: ${strengthValue}`);
    } else {
      console.log("[Proxy Image] 偵測到純文字生圖模式 (未傳入圖片)");
    }

    const cfUrl = `https://cloudflare.com{CF_ACCOUNT}/ai/run/${model}`;
    
    // 💡 6. 關鍵：不要設定 Content-Type！由原生 fetch 透過 FormData 自動在底層配置最穩定的 Multipart Boundary
    const cfRes = await fetch(cfUrl, {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${CF_TOKEN}`
      },
      body: form
    });

    const text = await cfRes.text();
    console.log("[Proxy Image] Cloudflare 響應狀態碼:", cfRes.status);
    
    if (!cfRes.ok) { 
      console.error("[Proxy Image] Cloudflare API 報錯:", text); 
      return res.status(cfRes.status).json({ error: { message: text } }); 
    }

    const data = JSON.parse(text);
    const outputImage = data.result?.image || data.result;
    
    res.json({ 
      created: Date.now(), 
      data: [{ b64_json: outputImage }] 
    });

  } catch (e) { 
    console.error("[Proxy Image] 執行階段發生崩潰錯誤:", e); 
    res.status(500).json({ error: { message: e.message } }); 
  }
}

app.post("/v1/images/generations", handleImage);
app.post("/v1/images/edits", handleImage);

app.listen(PORT, () => console.log("V10 running on port " + PORT));
