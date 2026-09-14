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
      { id: "@cf/meta/llama-3.1-8b-instruct", object: "model", owned_by: "meta" },
      { id: "@cf/ibm-granite/granite-4.0-h-micro", object: "model", owned_by: "ibm" },
      { id: "@cf/black-forest-labs/flux-2-klein-4b", object: "model", owned_by: "black-forest" }
  ]});
});

// --- CHAT 終極修正 ---
app.post("/v1/chat/completions", async (req,res)=>{
  try{
    let model = req.body.model||MODELS.LLAMA;
    // 強制禁用所有 fast
    model = model.replace("-fast","").replace("granite-4.0-h-micro",MODELS.GRANITE);
    if(!model.includes("granite") &&!model.includes("llama")) model = MODELS.LLAMA;

    const messages = (req.body.messages||[]).map(m=>{
      let c = m.content; if(Array.isArray(c)) c=c.map(x=>typeof x==="string"?x:x.text||"").join("\n"); return {role:m.role,content:String(c||"")};
    });

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions`;
    const cfRes = await fetch(cfUrl,{
      method:"POST",
      headers:{Authorization:`Bearer ${CF_TOKEN}`,"Content-Type":"application/json"},
      body: JSON.stringify({model, messages, stream:!!req.body.stream})
    });

    if(!cfRes.ok){const t=await cfRes.text(); return res.status(cfRes.status).json({error:{message:t}});}

    if(req.body.stream){
      res.setHeader("Content-Type","text/event-stream"); res.setHeader("Cache-Control","no-cache");
      const reader = cfRes.body.getReader(); const decoder=new TextDecoder(); let buf="";
      while(true){
        const {done,value}=await reader.read(); if(done)break;
        buf+=decoder.decode(value,{stream:true});
        let lines=buf.split("\n"); buf=lines.pop()||"";
        for(let line of lines){
          if(!line.startsWith("data:")) continue;
          let p=line.slice(5).trim(); if(p==="[DONE]"){res.write("data: [DONE]\n\n"); continue;}
          if(!p) continue;
          try{
            let j=JSON.parse(p);
            if(j.choices?.[0]?.delta && j.choices[0].delta.content!=null){
              j.choices[0].delta.content = String(j.choices[0].delta.content);
            }
            res.write(`data: ${JSON.stringify(j)}\n\n`);
          }catch{ /* 忽略 */ }
        }
      }
      res.end();
    }else{
      const t=await cfRes.text(); res.setHeader("Content-Type","application/json"); res.send(t);
    }
  }catch(e){ console.error(e); res.status(500).json({error:{message:e.message}});}
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
