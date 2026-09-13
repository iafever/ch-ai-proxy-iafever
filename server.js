import express from "express";
import cors from "cors";
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
const CF_TOKEN = process.env.CF_API_TOKEN;

const MODELS = {
  IMAGE: "@cf/black-forest-labs/flux-2-klein-4b",
  LLAMA: "@cf/meta/llama-3.1-8b-instruct",
  GRANITE: "@cf/ibm/granite-3-8b-instruct"
};

// --- 給 cron-job.org 用的，必須有回應字串 ---
app.get("/ping", (req,res)=>{
  res.set("Content-Type","text/plain");
  res.send(`pong - ${MODELS.IMAGE} + ${MODELS.LLAMA} + ${MODELS.GRANITE} alive - ${new Date().toISOString()}`);
});

app.get("/health", (req,res)=>{
  res.json({ status:"ok", models:Object.values(MODELS), time:new Date().toISOString() });
});

app.get("/", (req,res)=>{
  res.set("Content-Type","text/plain");
  res.send(`ready - ${MODELS.IMAGE} + ${MODELS.LLAMA} + ${MODELS.GRANITE}`);
});

app.get("/v1/models", (req,res)=>{
  res.json({
    data: [
      { id: MODELS.IMAGE, object:"model" },
      { id: MODELS.LLAMA, object:"model" },
      { id: MODELS.GRANITE, object:"model" }
    ]
  });
});

// --- 圖片：只用 flux-2-klein-4b，JSON 傳圖，臉不會變男 ---
async function handleImage(req, res) {
  try {
    let prompt = String(req.body.prompt || "photo");
    const size = (req.body.size || "1024x1024").split("x");
    const width = parseInt(size[0])||1024;
    const height = parseInt(size[1])||1024;
    const imgInput = req.body.image || req.body.image_b64;

    if (imgInput && !prompt.toLowerCase().match(/woman|man|female|male/)) {
      prompt = `same woman, identical face, face unchanged, female, ${prompt}`;
    }

    const payload = {
      prompt: prompt,
      width: width,
      height: height,
      num_steps: 8,
      guidance: 3.5,
    };

    if (imgInput) {
      payload.image = String(imgInput).split(",").pop();
      payload.strength = parseFloat(req.body.strength || 0.22); // 臉不變只換衣服背景用 0.22
      console.log(`IMG2IMG flux-2-klein-4b strength=${payload.strength}`);
    } else {
      console.log(`TEXT2IMG flux-2-klein-4b`);
    }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${MODELS.IMAGE}`;
    const cfRes = await fetch(cfUrl, {
      method:"POST",
      headers:{ Authorization:`Bearer ${CF_TOKEN}`, "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });

    const text = await cfRes.text();
    if (!cfRes.ok) {
      console.error("CF IMAGE ERROR:", text);
      return res.status(500).json({ error:{message:text} });
    }
    const data = JSON.parse(text);
    res.json({ created: Date.now(), data:[{ b64_json: data.result?.image || data.result }] });
  } catch(e){
    console.error(e);
    res.status(500).json({ error:{message:e.message} });
  }
}

// --- 文字：llama 3.1 8b 和 granite 3 8b ---
async function handleChat(req, res) {
  try {
    const modelReq = req.body.model || MODELS.LLAMA;
    if (modelReq.includes("flux")) return handleImage(req,res);

    let modelId = MODELS.LLAMA;
    if (modelReq.includes("granite")) modelId = MODELS.GRANITE;
    if (modelReq.includes("llama")) modelId = MODELS.LLAMA;

    const messages = req.body.messages || [{ role:"user", content: req.body.prompt || "" }];

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${modelId}`;
    const cfRes = await fetch(cfUrl, {
      method:"POST",
      headers:{ Authorization:`Bearer ${CF_TOKEN}`, "Content-Type":"application/json" },
      body: JSON.stringify({ messages })
    });

    const text = await cfRes.text();
    if (!cfRes.ok) return res.status(500).json({ error:{message:text} });
    const data = JSON.parse(text);
    const reply = data.result?.response || data.result || "";

    res.json({
      id: "chatcmpl-"+Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now()/1000),
      model: modelId,
      choices: [{ index:0, message:{ role:"assistant", content: reply }, finish_reason:"stop" }]
    });
  } catch(e){
    res.status(500).json({ error:{message:e.message} });
  }
}

app.post("/v1/images/generations", handleImage);
app.post("/v1/chat/completions", handleChat);

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log(`Server running ${PORT} - ${MODELS.IMAGE} + LLAMA + GRANITE`));
