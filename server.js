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

app.post("/v1/chat/completions", async (req,res)=>{
  try{
    let model = String(req.body.model || MODELS.QWEN);
    if(model.includes("llama") || model.includes("fast")) model = MODELS.QWEN;
    if(model.includes("ibm/granite") && !model.includes("ibm-granite")) model = MODELS.GRANITE;
    if(!model.includes("qwen") && !model.includes("granite")) model = MODELS.QWEN;

    const {reasoning_effort, ...rest} = req.body;

    const messages = (rest.messages||[]).map(m=>{
      let c=m.content;
      if(Array.isArray(c)) c=c.map(x=>typeof x==="string"?x:(x.text||x.content||"")).join("\n");
      return {role:m.role||"user", content:String(c||"")};
    }).filter(m=>m.content);

    console.log(`CHAT model=${model} stream=${!!rest.stream}`);

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions`;
    const cfRes = await fetch(cfUrl,{
      method:"POST",
      headers:{Authorization:`Bearer ${CF_TOKEN}`,"Content-Type":"application/json"},
      // granite 斷流主因：不要送多餘參數，只送 model/messages/stream
      body: JSON.stringify({model, messages, stream:!!rest.stream})
    });

    if(!cfRes.ok){
      const t=await cfRes.text();
      console.error("CF ERROR",t);
      return res.status(cfRes.status).json({error:{message:t}});
    }

    if(rest.stream){
      res.setHeader("Content-Type","text/event-stream");
      res.setHeader("Cache-Control","no-cache");
      res.setHeader("Connection","keep-alive");
      res.setHeader("X-Accel-Buffering","no");

      const reader = cfRes.body.getReader();
      const decoder = new TextDecoder();
      let buf="";

      // granite 會先吐 reasoning，qwen 不會，所以要把 reasoning 合併成 content
      while(true){
        const {done,value}=await reader.read();
        if(done) break;
        buf+=decoder.decode(value,{stream:true});
        // 用 \n\n 切 SSE 才不會切斷 JSON
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for(const ev of events){
          if(!ev.trim()) continue;
          // 一個事件可能有多行 data:
          const lines = ev.split("\n");
          for(const line of lines){
            if(!line.startsWith("data:")) continue;
            const p=line.slice(5).trim();
            if(p==="[DONE]"){ res.write("data: [DONE]\n\n"); continue; }
            if(!p) continue;
            try{
              let j=JSON.parse(p);

              // --- granite 斷流修復核心 ---
              const delta = j.choices?.[0]?.delta;
              if(delta){
                // granite 會把思考放在 reasoning / reasoning_content，Cherry 看不到 content 就斷了
                if(delta.reasoning_content && !delta.content){
                  delta.content = delta.reasoning_content;
                  delete delta.reasoning_content;
                }
                if(delta.reasoning && !delta.content){
                  // reasoning 是字串時，直接當 content
                  if(typeof delta.reasoning === "string"){
                    delta.content = delta.reasoning;
                    delete delta.reasoning;
                  }
                }
                // 空 delta 也要轉成空字串，避免 Cherry 誤判結束
                if(delta.content==null && delta.reasoning==null && delta.reasoning_content==null){
                  // 有時 granite 只吐 role，保留 role
                  if(!delta.role){
                    continue; // 跳過完全空的 delta
                  }
                }
                if(delta.content!=null) delta.content=String(delta.content);
              }

              const msg = j.choices?.[0]?.message;
              if(msg){
                if(msg.reasoning_content && !msg.content) msg.content = msg.reasoning_content;
                if(msg.content!=null) msg.content=String(msg.content);
              }

              if(j.model) j.model = j.model.replace("-fast","");

              res.write(`data: ${JSON.stringify(j)}\n\n`);
            }catch(e){
              // 半截 JSON 留到下一輪
              buf = ev + "\n\n" + buf;
              break;
            }
          }
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    }else{
      const txt=await cfRes.text();
      let data;
      try{ data=JSON.parse(txt); }catch{ return res.setHeader("Content-Type","application/json").send(txt); }
      const out = data.result || data;
      res.setHeader("Content-Type","application/json");
      res.json(out);
    }
  }catch(e){
    console.error("CHAT ERROR",e);
    if(!res.headersSent) res.status(500).json({error:{message:e.message}});
  }
});

async function handleImage(req, res) {
  try {
    const model = "@cf/black-forest-labs/flux-2-klein-4b";
    const prompt = String(req.body.prompt || "full body photo of the same person, same face");
    const size = (req.body.size || "910x512").split("x");
    const width = String(parseInt(size[0]) || 910);
    const height = String(parseInt(size[1]) || 512);
    const imgInput = req.body.image || req.body.image_b64;

    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", width);
    form.append("height", height);
    form.append("steps", "4");

    if (imgInput) {
      const b64 = String(imgInput).includes(",")? String(imgInput).split(",")[1] : String(imgInput);
      const buffer = Buffer.from(b64, "base64");
      // 關鍵：檔名要是 input.jpg，type 要 image/jpeg
      form.append("image", new Blob([buffer], {type:"image/jpeg"}), "input.jpg");
      form.append("strength", String(req.body.strength || 0.5));
      console.log("KLEIN IMG2IMG MULTIPART, size", buffer.length);
    } else {
      console.log("KLEIN TEXT2IMG MULTIPART");
    }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}`;
    const cfRes = await fetch(cfUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_TOKEN}` }, // multipart 不要自己加 Content-Type
      body: form
    });

    const text = await cfRes.text();
    console.log("CF STATUS", cfRes.status);
    if (!cfRes.ok) { console.error("CF KLEIN ERROR:", text); return res.status(cfRes.status).json({ error:{message:text} }); }

    const data = JSON.parse(text);
    res.json({ created: Date.now(), data:[{ b64_json: data.result?.image || data.result }] });

  } catch (e) { console.error("FINAL ERROR", e); res.status(500).json({error:{message:e.message}}); }
}

app.post("/v1/images/generations", handleImage);
app.post("/v1/images/edits", handleImage);

app.listen(PORT,()=>console.log("V9 running "+PORT));
