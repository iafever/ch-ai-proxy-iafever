import express from "express";
import cors from "cors";
import FormData from "form-data";

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
    const model = "@cf/black-forest-labs/flux-2-klein-4b";
    
    // 1. 核心心法：在 Prompt 裡強制「鎖定性別」並告訴模型參考第 0 張圖，防止其隨機生成男性
    const userPrompt = req.body.prompt || "changing clothes";
    const prompt = `A beautiful young woman, keeping the identical face and hair from image 0, ${userPrompt}. Realistic photography, masterpiece.`;
    
    const size = (req.body.size || "1024x1024").split("x");
    const width = parseInt(size[0]) || 1024;
    const height = parseInt(size[1]) || 1024;
    const imgInput = req.body.image || req.body.image_b64;

    // 2. 使用穩定的外部 form-data 庫，不要用 Node 原生不成熟的 FormData
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(width));
    form.append("height", String(height));
    
    // 💡 提示：Cloudflare Klein 4B 模型在 REST API 的 steps 參數是固定的，所以此處不手動帶入 steps 欄位

    if (imgInput) {
      // 3. 乾淨切除 Base64 的開頭 Data URI 宣告
      const b64 = String(imgInput).includes(",") ? String(imgInput).split(",")[1] : String(imgInput);
      const buffer = Buffer.from(b64, "base64");
      
      // 4. 關鍵規格修正：欄位名稱必須是 input_image_0 (不可為 image)
      // 使用 form-data 庫的 .append(key, buffer, options) 形式，能完美生成符合 HTTP 規範的二進位欄位
      form.append("input_image_0", buffer, {
        filename: "input.jpg",
        contentType: "image/jpeg"
      });
      
      // 5. 提高重繪強度 (預設給 0.8)，給予 AI 足夠空間擦除舊衣服/背景，同時依賴 image 0 抓回臉部
      const strengthValue = String(req.body.strength || 0.8);
      form.append("strength", strengthValue);
      
      console.log(`[Proxy Image] 成功封裝圖片. 大小: ${buffer.length} bytes, 強度: ${strengthValue}`);
    } else {
      console.log("[Proxy Image] 純文字生圖模式 (未偵測到輸入圖片)");
    }

    const cfUrl = `https://cloudflare.com{CF_ACCOUNT}/ai/run/${model}`;
    
    // 6. 關鍵 headers 發送：必須帶入 form.getHeaders() 以取得正確的 boundary，千萬不能手動寫死 Content-Type
    const cfRes = await fetch(cfUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        ...form.getHeaders() 
      },
      body: form
    });

    const text = await cfRes.text();
    console.log("[Proxy Image] Cloudflare 回傳狀態碼:", cfRes.status);
    
    if (!cfRes.ok) { 
      console.error("[Proxy Image] Cloudflare 報錯訊息:", text); 
      return res.status(cfRes.status).json({ error: { message: text } }); 
    }

    const data = JSON.parse(text);
    
    // 7. 支援相容性輸出
    const outputImage = data.result?.image || data.result;
    res.json({ 
      created: Date.now(), 
      data: [{ b64_json: outputImage }] 
    });

  } catch (e) { 
    console.error("[Proxy Image] 發生異常錯誤:", e); 
    res.status(500).json({ error: { message: e.message } }); 
  }
}

app.post("/v1/images/generations", handleImage);
app.post("/v1/images/edits", handleImage);

app.listen(PORT,()=>console.log("V9 running "+PORT));
