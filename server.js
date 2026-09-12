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

app.get("/", (req,res)=>res.send("V9 OK "+new Date().toISOString()));
app.get("/v1/models", (req,res)=>{
  res.json({ object:"list", data:[
      { id: "@cf/meta/llama-3.1-8b-instruct-fast", object: "model", owned_by: "meta" },
      { id: "@cf/ibm-granite/granite-4.0-h-micro", object: "model", owned_by: "ibm" },
      {id:"@cf/black-forest-labs/flux-1-schnell", object:"model", owned_by:"black-forest"},
      { id: "@cf/black-forest-labs/flux-2-klein-4b", object: "model", owned_by: "black-forest" }
  ]});
});

app.post("/v1/chat/completions", async (req,res)=>{
  try{
    let { model, messages, stream } = req.body;
    messages = normalizeMessages(messages);
    
    // granite 用新版 v1, flux 那些不用
    const isChatModel = model.includes("granite") || model.includes("llama") || model.includes("gemma");
    const cfUrl = isChatModel
      ? `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions`
      : `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}`;

    const body = isChatModel ? { model, messages, stream: !!stream } : { messages };

    const cfRes = await fetch(cfUrl, {
      method:"POST",
      headers:{ Authorization:`Bearer ${CF_TOKEN}`, "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });

    if(!cfRes.ok){
      const t = await cfRes.text();
      console.error("CF ERROR:", t);
      return res.status(cfRes.status).json({ error:{ message:"AiError: "+t, type:"api_error", code:"cloudflare_api_error" }});
    }

    if(stream && isChatModel){
      res.setHeader("Content-Type","text/event-stream");
      res.setHeader("Cache-Control","no-cache");
      const reader = cfRes.body.getReader();
      while(true){
        const {done,value} = await reader.read();
        if(done) break;
        res.write(value);
      }
      res.end();
    } else if(stream) {
      // 舊版 /ai/run/ 的串流處理
      res.setHeader("Content-Type","text/event-stream");
      const reader = cfRes.body.getReader();
      const decoder = new TextDecoder();
      while(true){
        const {done,value} = await reader.read();
        if(done) break;
        const chunk = decoder.decode(value,{stream:true});
        for(const line of chunk.split("\n")){
          if(line.startsWith("data:")){
            try{
              const j = JSON.parse(line.slice(5));
              if(j.response) res.write(`data: ${JSON.stringify({choices:[{delta:{content:j.response}}]})}\n\n`);
            }catch{ res.write(line+"\n\n"); }
          }
        }
      }
      res.write("data: [DONE]\n\n"); res.end();
    } else {
      const text = await cfRes.text();
      res.setHeader("Content-Type","application/json");
      res.send(text);
    }
  }catch(e){
    console.error(e);
    res.status(500).json({error:{message:e.message}});
  }
});

async function handleImage(req, res) {
  try {
    const model = "@cf/black-forest-labs/flux-2-klein-4b"; // 鎖便宜這顆
    const prompt = req.body.prompt || "photo";
    const size = (req.body.size || "1024x1024").split("x");
    const width = parseInt(size[0]) || 1024;
    const height = parseInt(size[1]) || 1024;
    const imgInput = req.body.image || req.body.image_b64;

    // flux-2-klein-4b 官方正確參數，照這個才不會 5006
    const payload = {
      prompt: String(prompt),
      width: width,
      height: height,
      steps: 8, // klein 只要 8 步就好，最便宜最快
    };

    if (imgInput) {
      const b64 = typeof imgInput === "string" && imgInput.includes(",")? imgInput.split(",")[1] : imgInput;
      payload.image = b64;
      payload.strength = parseFloat(req.body.strength || 0.5); // 大頭照轉全身就用 0.5
      console.log("KLEIN IMG2IMG strength", payload.strength);
    } else {
      console.log("KLEIN TEXT2IMG");
    }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}`;
    const cfRes = await fetch(cfUrl, {
      method:"POST",
      headers:{ Authorization:`Bearer ${CF_TOKEN}`, "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });

    const text = await cfRes.text();
    if (!cfRes.ok) { console.error("CF KLEIN ERROR:", text); return res.status(cfRes.status).json({ error:{message:text} }); }
    const data = JSON.parse(text);
    res.json({ created: Date.now(), data:[{ b64_json: data.result?.image || data.result }] });

  } catch (e) { console.error(e); res.status(500).json({error:{message:e.message}}); }
}

app.post("/v1/images/generations", handleImage);
app.post("/v1/images/edits", handleImage);

app.listen(PORT,()=>console.log("V9 running "+PORT));
