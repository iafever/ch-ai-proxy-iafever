import express from "express";
import cors from "cors";
import multer from "multer";
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
const CF_TOKEN = process.env.CF_API_TOKEN;

const MODELS = {
  IMAGE: "@cf/black-forest-labs/flux-2-klein-4b",
  LLAMA: "@cf/meta/llama-3.1-8b-instruct",
  GRANITE: "@cf/ibm/granite-3-8b-instruct"
};

app.get("/ping", (req,res)=>{ res.set("Content-Type","text/plain"); res.send(`pong - ${MODELS.IMAGE} + ${MODELS.LLAMA} + ${MODELS.GRANITE} alive - ${new Date().toISOString()}`); });
app.get("/health", (req,res)=>res.json({ status:"ok", models:Object.values(MODELS), time:new Date().toISOString() }));
app.get("/", (req,res)=>res.set("Content-Type","text/plain").send(`ready - ${MODELS.IMAGE} + ${MODELS.LLAMA} + ${MODELS.GRANITE}`));
app.get("/v1/models", (req,res)=>res.json({ data:[{id:MODELS.IMAGE,object:"model"},{id:MODELS.LLAMA,object:"model"},{id:MODELS.GRANITE,object:"model"}] }));

async function handleImage(req, res) {
  try {
    let prompt = String(req.body.prompt || req.body.Prompt || "photo");
    const size = (req.body.size || "1024x1024").split("x");
    const width = parseInt(size[0])||1024;
    const height = parseInt(size[1])||1024;
    
    // 雙吃：JSON 的 image_b64 或 multipart 的 file
    let b64 = null;
    if (req.file) {
      b64 = req.file.buffer.toString("base64");
      console.log("MULTIPART image received", req.file.size);
    } else {
      const imgInput = req.body.image || req.body.image_b64;
      if (imgInput) b64 = String(imgInput).split(",").pop();
    }

    if (b64 && !prompt.toLowerCase().match(/woman|man|female|male/)) {
      prompt = `same woman, identical face, face unchanged, female, ${prompt}`;
    }

    const payload = { prompt, width, height, num_steps: 8, guidance: 3.5 };
    if (b64) {
      payload.image = b64;
      payload.strength = parseFloat(req.body.strength || 0.22);
      console.log(`IMG2IMG flux-2-klein-4b strength=${payload.strength} prompt=${prompt.substring(0,50)}`);
    }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${MODELS.IMAGE}`;
    const cfRes = await fetch(cfUrl, { method:"POST", headers:{ Authorization:`Bearer ${CF_TOKEN}`, "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    const text = await cfRes.text();
    if (!cfRes.ok) { console.error(text); return res.status(500).json({ error:{message:text} }); }
    const data = JSON.parse(text);
    res.json({ created: Date.now(), data:[{ b64_json: data.result?.image || data.result }] });
  } catch(e){ console.error(e); res.status(500).json({ error:{message:e.message} }); }
}

async function handleChat(req, res) {
  const modelReq = req.body.model || MODELS.LLAMA;
  if (modelReq.includes("flux")) return handleImage(req,res);
  let modelId = MODELS.LLAMA;
  if (modelReq.includes("granite")) modelId = MODELS.GRANITE;
  const messages = req.body.messages || [{ role:"user", content: req.body.prompt || "" }];
  const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${modelId}`;
  const cfRes = await fetch(cfUrl, { method:"POST", headers:{ Authorization:`Bearer ${CF_TOKEN}`, "Content-Type":"application/json" }, body: JSON.stringify({ messages }) });
  const text = await cfRes.text();
  if (!cfRes.ok) return res.status(500).json({ error:{message:text} });
  const data = JSON.parse(text);
  res.json({ id:"chatcmpl-"+Date.now(), object:"chat.completion", choices:[{ message:{ role:"assistant", content: data.result?.response || data.result }, finish_reason:"stop" }] });
}

// 重點：edits 必須用 upload.single("image") 接 multipart
app.post("/v1/images/generations", handleImage);
app.post("/v1/images/edits", upload.single("image"), handleImage);
app.post("/v1/images/variations", upload.single("image"), handleImage);
app.post("/v1/chat/completions", handleChat);

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log("Running"));
