import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const CF_ACCOUNT = (process.env.CF_ACCOUNT_ID || "").trim();
const CF_TOKEN = (process.env.CF_API_TOKEN || "").trim();
const PORT = process.env.PORT || 10000;

const MODELS = {
  IMAGE: "@cf/black-forest-labs/flux-2-klein-4b",
  LLAMA: "@cf/meta/llama-3.1-8b-instruct",
  GRANITE: "@cf/ibm/granite-3-8b-instruct"
};

function normalizeMessages(msgs) {
  return (msgs || []).map(m => {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map(c => typeof c === "string" ? c : (c.text || c.content || "")).join("\n");
    }
    if (typeof content !== "string") content = String(content || "");
    return { role: m.role || "user", content };
  }).filter(m => m.content);
}

// 給 cron-job.org 用的，必須回字串
app.get("/ping", (req, res) => {
  res.set("Content-Type", "text/plain");
  res.send(`pong - ${MODELS.IMAGE} + ${MODELS.LLAMA} + ${MODELS.GRANITE} alive - ${new Date().toISOString()}`);
});
app.get("/health", (req, res) => res.json({ status: "ok", models: Object.values(MODELS), time: new Date().toISOString() }));
app.get("/", (req, res) => res.set("Content-Type", "text/plain").send(`ready - ${MODELS.IMAGE} + ${MODELS.LLAMA} + ${MODELS.GRANITE}`));

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: MODELS.IMAGE, object: "model", owned_by: "black-forest" },
      { id: MODELS.LLAMA, object: "model", owned_by: "meta" },
      { id: MODELS.GRANITE, object: "model", owned_by: "ibm" }
    ]
  });
});

// ---- LLM: 修正 content:2 的問題 ----
app.post("/v1/chat/completions", async (req, res) => {
  try {
    let { model, messages, stream } = req.body;
    messages = normalizeMessages(messages);

    // 禁用 fast 模型，fast 會回數字 content
    let cfModel = model || MODELS.LLAMA;
    if (cfModel.includes("fast")) cfModel = cfModel.replace("-fast", "");
    if (cfModel.includes("granite-4.0")) cfModel = MODELS.GRANITE;
    if (cfModel.includes("llama")) cfModel = MODELS.LLAMA;

    const isChatModel = cfModel.includes("granite") || cfModel.includes("llama") || cfModel.includes("gemma");
    const cfUrl = isChatModel
      ? `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions`
      : `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${cfModel}`;

    const body = isChatModel ? { model: cfModel, messages, stream: !!stream } : { messages };

    const cfRes = await fetch(cfUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!cfRes.ok) {
      const t = await cfRes.text();
      console.error("CF ERROR:", t);
      return res.status(cfRes.status).json({ error: { message: "AiError: " + t } });
    }

    if (stream && isChatModel) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const decoder = new TextDecoder();
      const reader = cfRes.body.getReader();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]" || !payload) {
            res.write(`data: ${payload}\n\n`);
            continue;
          }
          try {
            const j = JSON.parse(payload);
            // 修正 content 是數字 2 的問題 -> 強制轉字串
            if (j.choices?.[0]?.delta?.content !== undefined) {
              j.choices[0].delta.content = String(j.choices[0].delta.content);
            }
            if (j.choices?.[0]?.message?.content !== undefined) {
              j.choices[0].message.content = String(j.choices[0].message.content);
            }
            res.write(`data: ${JSON.stringify(j)}\n\n`);
          } catch {
            res.write(line + "\n\n");
          }
        }
      }
      res.end();
    } else {
      const text = await cfRes.text();
      res.setHeader("Content-Type", "application/json");
      res.send(text);
    }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: { message: e.message } });
  }
});

// ---- IMAGE: 入口吃 multipart，出口吃 JSON (解決你女變男 + multipart 報錯) ----
async function handleImage(req, res) {
  try {
    const promptRaw = req.body.prompt || req.body.Prompt || "photo";
    let prompt = String(promptRaw);
    const size = (req.body.size || "1024x1024").split("x");
    const width = parseInt(size[0]) || 1024;
    const height = parseInt(size[1]) || 1024;

    // 1. 萬用接圖：不管 Cherry 送 image / image[] / file / files
    let b64 = null;
    if (req.files && req.files.length > 0) {
      b64 = req.files[0].buffer.toString("base64");
      console.log("MULTIPART IN image[]", req.files[0].fieldname, req.files[0].size);
    } else if (req.file) {
      b64 = req.file.buffer.toString("base64");
      console.log("MULTIPART IN single", req.file.size);
    } else {
      const imgInput = req.body.image || req.body.image_b64;
      if (imgInput) b64 = String(imgInput).split(",").pop();
    }

    // 2. 保臉 Prompt
    if (b64 && !prompt.toLowerCase().match(/woman|man|female|male|person/)) {
      prompt = `same woman, identical face, face unchanged, female, ${prompt}`;
    }

    // 3. 出口一律用 JSON 給 Cloudflare，klein-4b 用 JSON 才不會 5006
    const payload = {
      prompt,
      width,
      height,
      num_steps: 8,
      guidance: 3.5
    };
    if (b64) {
      payload.image = b64;
      payload.strength = parseFloat(req.body.strength || 0.22);
      console.log(`KLEIN IMG2IMG JSON out strength=${payload.strength}`);
    } else {
      console.log("KLEIN TEXT2IMG JSON out");
    }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${MODELS.IMAGE}`;
    const cfRes = await fetch(cfUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await cfRes.text();
    console.log("CF STATUS", cfRes.status);
    if (!cfRes.ok) {
      console.error("CF KLEIN ERROR:", text);
      return res.status(cfRes.status).json({ error: { message: text } });
    }

    const data = JSON.parse(text);
    res.json({ created: Date.now(), data: [{ b64_json: data.result?.image || data.result }] });
  } catch (e) {
    console.error("FINAL ERROR", e);
    res.status(500).json({ error: { message: e.message } });
  }
}

const multipartHandler = upload.any();
app.post("/v1/images/generations", multipartHandler, handleImage);
app.post("/v1/images/edits", multipartHandler, handleImage);
app.post("/v1/images/variations", multipartHandler, handleImage);

app.listen(PORT, () => console.log(`V10 fixed running ${PORT}`));
