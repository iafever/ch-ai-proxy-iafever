import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const CF_ACCOUNT = (process.env.CF_ACCOUNT_ID || "").trim();
const CF_TOKEN = (process.env.CF_API_TOKEN || "").trim();
const PORT = process.env.PORT || 10000;

const MODELS = {
  QWEN: "@cf/qwen/qwen3-30b-a3b-fp8",
  GRANITE: "@cf/ibm-granite/granite-4.0-h-micro",
  IMAGE: "@cf/black-forest-labs/flux-2-klein-4b"
};

app.get("/ping", (req, res) => {
  res.type("text/plain").send(`pong - ${MODELS.QWEN} + ${MODELS.GRANITE} + ${MODELS.IMAGE} alive - ${new Date().toISOString()}`);
});
app.get("/health", (req, res) => res.json({ status: "ok", models: Object.values(MODELS), time: new Date().toISOString() }));
app.get("/", (req, res) => res.type("text/plain").send(`ready V15 qwen+granite+flux`));
app.get("/v1/models", (req, res) => res.json({
  object: "list",
  data: [
    { id: MODELS.QWEN, object: "model", owned_by: "qwen" },
    { id: MODELS.GRANITE, object: "model", owned_by: "ibm" },
    { id: MODELS.IMAGE, object: "model", owned_by: "black-forest" }
  ]
}));

// --- 手寫 multipart 解析，不用 multer ---
function parseMultipart(req) {
  return new Promise((resolve) => {
    const ct = req.headers["content-type"] || "";
    if (!ct.includes("multipart/form-data")) {
      resolve({ fields: req.body, fileB64: null });
      return;
    }
    const boundary = ct.split("boundary=")[1];
    if (!boundary) {
      resolve({ fields: req.body, fileB64: null });
      return;
    }
    let chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString("latin1");
        const parts = text.split("--" + boundary);
        let fields = {};
        let fileB64 = null;

        for (let part of parts) {
          if (part.includes('name="prompt"')) {
            const m = part.split("\r\n\r\n");
            if (m[1]) fields.prompt = m[1].split("\r\n--")[0].trim();
          }
          if (part.includes('name="size"')) {
            const m = part.split("\r\n\r\n");
            if (m[1]) fields.size = m[1].split("\r\n--")[0].trim();
          }
          if (part.includes('name="strength"')) {
            const m = part.split("\r\n\r\n");
            if (m[1]) fields.strength = m[1].split("\r\n--")[0].trim();
          }
          // 抓圖，不管欄位叫 image 還是 image[]
          if (part.includes('filename="')) {
            const headerEnd = buffer.indexOf("\r\n\r\n", buffer.indexOf(part.slice(0,200), 0, "latin1"));
            // 用 binary 切法找檔案內容
            const partStart = text.indexOf(part);
            // 這個 part 在 buffer 的位置
            const partBuffer = Buffer.from(part, "latin1");
            // 真正的檔案二進位
            let fileStart = part.indexOf("\r\n\r\n") + 4;
            let fileEnd = part.lastIndexOf("\r\n");
            let fileContent = part.slice(fileStart, fileEnd);
            // latin1 -> buffer -> base64
            if (fileContent.length > 100) {
              fileB64 = Buffer.from(fileContent, "latin1").toString("base64");
            }
          }
        }
        resolve({ fields, fileB64 });
      } catch (e) {
        console.error("parseMultipart error", e);
        resolve({ fields: req.body, fileB64: null });
      }
    });
  });
}

app.post("/v1/chat/completions", async (req, res) => {
  try {
    let model = String(req.body.model || MODELS.QWEN);
    if (model.includes("llama") || model.includes("fast")) {
      model = MODELS.QWEN;
    }
    if (model.includes("ibm/granite")) {
      model = MODELS.GRANITE;
    }
    if (!model.includes("qwen") && !model.includes("granite")) {
      model = MODELS.QWEN;
    }

    const messages = (req.body.messages || []).map(m => {
      let c = m.content;
      if (Array.isArray(c)) c = c.map(x => typeof x === "string" ? x : (x.text || x.content || "")).join("\n");
      return { role: m.role || "user", content: String(c || "") };
    }).filter(m => m.content);

    console.log(`CHAT model=${model} stream=${!!req.body.stream}`);

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions`;
    const cfRes = await fetch(cfUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: !!req.body.stream })
    });

    if (!cfRes.ok) {
      const t = await cfRes.text();
      console.error("CF ERROR", t);
      return res.status(cfRes.status).json({ error: { message: t } });
    }

    if (req.body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const reader = cfRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const p = line.slice(5).trim();
          if (p === "[DONE]") { res.write("data: [DONE]\n\n"); continue; }
          if (!p) continue;
          try {
            const j = JSON.parse(p);
            if (j.choices?.[0]?.delta?.content != null) {
              j.choices[0].delta.content = String(j.choices[0].delta.content);
            }
            if (j.choices?.[0]?.message?.content != null) {
              j.choices[0].message.content = String(j.choices[0].message.content);
            }
            if (j.model) j.model = j.model.replace("-fast", "");
            res.write(`data: ${JSON.stringify(j)}\n\n`);
          } catch {}
        }
      }
      res.end();
    } else {
      const txt = await cfRes.text();
      res.setHeader("Content-Type", "application/json");
      res.send(txt);
    }
  } catch (e) {
    console.error("CHAT ERROR", e);
    if (!res.headersSent) res.status(500).json({ error: { message: e.message } });
  }
});

// --- IMAGE：入口吃 multipart(自己解析)，出口用 JSON 給 CF ---
async function handleImage(req, res) {
  try {
    const { fields, fileB64 } = await parseMultipart(req);
    const body = {...req.body,...fields };

    let b64 = fileB64;
    if (!b64) {
      const imgInput = body.image || body.image_b64 || req.body.image || req.body.image_b64;
      if (imgInput) b64 = String(imgInput).split(",").pop();
    }

    let prompt = String(body.prompt || req.body.prompt || "photo");
    if (b64 &&!/woman|man|female|male|person/i.test(prompt)) {
      prompt = `same woman, identical face, face unchanged, female, ${prompt}`;
    }

    const size = (body.size || req.body.size || "1024x1024").split("x");
    const payload = {
      prompt,
      width: parseInt(size[0]) || 1024,
      height: parseInt(size[1]) || 1024,
      num_steps: 8,
      guidance: 3.5
    };
    if (b64) {
      payload.image = b64;
      payload.strength = parseFloat(body.strength || req.body.strength || 0.22);
      console.log(`IMG2IMG no-multer b64 len=${b64.length} strength=${payload.strength}`);
    }

    const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${MODELS.IMAGE}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const txt = await cfRes.text();
    if (!cfRes.ok) return res.status(500).json({ error: { message: txt } });
    const d = JSON.parse(txt);
    res.json({ created: Date.now(), data: [{ b64_json: d.result?.image || d.result }] });
  } catch (e) {
    console.error("IMAGE ERROR", e);
    res.status(500).json({ error: { message: e.message } });
  }
}

// 注意：這裡不用任何 middleware，直接讓 handleImage 自己收 raw body
app.post("/v1/images/generations", (req, res) => { req.headers["content-type"]?.includes("multipart")? handleImage(req,res) : handleImage(req,res); });
app.post("/v1/images/edits", handleImage);
app.post("/v1/images/variations", handleImage);

app.listen(PORT, () => console.log(`V13 no-multer running ${PORT}`));
