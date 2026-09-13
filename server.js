import express from "express";
import cors from "cors";
import https from "https"; // 💡 引入 Node.js 內建的 https 模組來建立超穩定連線

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

app.get("/", (req, res) => res.send("V11 OK " + new Date().toISOString()));

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

// 🛠️ 採用內建 https 模組重構：完全免疫 fetch 網路斷流，且精準處理多圖參考規格
async function handleImage(req, res) {
  try {
    const model = "@cf/black-forest-labs/flux-2-klein-4b";
    
    // 1. 強制定錨提示詞，防範生成男性
    const userPrompt = req.body.prompt || "changing clothes";
    const prompt = `A beautiful young woman, keeping the identical face and hair from image 0, ${userPrompt}. Realistic photography, masterpiece.`;
    
    const size = (req.body.size || "1024x1024").split("x");
    const width = parseInt(size[0]) || 1024;
    const height = parseInt(size[1]) || 1024;
    const imgInput = req.body.image || req.body.image_b64;

    // 2. 手動建立極其穩定的二進位 Multipart Boundary，避免任何套件相容問題
    const boundary = "----WebKitFormBoundaryProxyServer" + Math.random().toString(36).substring(2);
    const chunks = [];

    // 寫入文字參數
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="width"\r\n\r\n${width}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="height"\r\n\r\n${height}\r\n`));

    if (imgInput) {
      const b64 = String(imgInput).includes(",") ? String(imgInput).split(",")[1] : String(imgInput);
      const buffer = Buffer.from(b64, "base64");
      
      // 3. 欄位精確對齊官方規範 input_image_0
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="input_image_0"; filename="input.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`));
      chunks.push(buffer);
      chunks.push(Buffer.from("\r\n"));
      
      // 4. 重繪強度高一點 (0.8) 給予換衣服背景的空間
      const strengthValue = String(req.body.strength || 0.8);
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="strength"\r\n\r\n${strengthValue}\r\n`));
      
      console.log(`[Proxy Image] 圖片已手動封裝成 Buffer。大小: ${buffer.length} 位元組`);
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const payload = Buffer.concat(chunks);

    // 5. 使用 https.request 並強逼採用 IPv4 (family: 4)，徹底解決 Render 平台上的 fetch failed 災情
    const options = {
      hostname: "://cloudflare.com",
      path: `/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}`,
      method: "POST",
      family: 4, // ⚠️ 強制只用 IPv4 連線，排除 IPv6 的握手 Bug！
      headers: {
        "Authorization": `Bearer ${CF_TOKEN}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.length
      }
    };

    const cfReq = https.request(options, (cfRes) => {
      let responseBody = "";
      cfRes.on("data", (chunk) => { responseBody += chunk; });
      cfRes.on("end", () => {
        console.log("[Proxy Image] Cloudflare 響應狀態碼:", cfRes.statusCode);
        
        if (cfRes.statusCode !== 200) {
          console.error("[Proxy Image] Cloudflare 報錯:", responseBody);
          return res.status(cfRes.statusCode).json({ error: { message: responseBody } });
        }

        try {
          const data = JSON.parse(responseBody);
          const outputImage = data.result?.image || data.result;
          res.json({ created: Date.now(), data: [{ b64_json: outputImage }] });
        } catch (err) {
          res.status(500).json({ error: { message: "解析 Cloudflare JSON 失敗: " + err.message } });
        }
      });
    });

    cfReq.on("error", (err) => {
      console.error("[Proxy Image] HTTPS 請求發生硬體/網路錯誤:", err);
      res.status(500).json({ error: { message: "連線 Cloudflare 失敗: " + err.message } });
    });

    cfReq.write(payload);
    cfReq.end();

  } catch (e) {
    console.error("[Proxy Image] 崩潰錯誤:", e);
    res.status(500).json({ error: { message: e.message } });
  }
}

app.post("/v1/images/generations", handleImage);
app.post("/v1/images/edits", handleImage);

app.listen(PORT, () => console.log("V11 running on port " + PORT));
