export default { async fetch(request, env) {
  const url = new URL(request.url); const path = url.pathname;
      
      /* =====================================================
         OPENROUTER FREE MODELS
         GET /models
      ===================================================== */
      if (
        path === "/models" &&
        request.method === "GET"
      ) {
        if (!env.OPENROUTER_API_KEY) {
          return json({ success: false, error: "OPENROUTER_API_KEY is missing." }, 500);
        }
        try {
          const modelResponse = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { "Authorization": "Bearer " + env.OPENROUTER_API_KEY }
          });
          const modelText = await modelResponse.text();
          if (!modelResponse.ok) {
            return json({ success: false, error: "OpenRouter models HTTP " + modelResponse.status, details: modelText }, modelResponse.status);
          }
          let modelJSON;
          try { modelJSON = modelText ? JSON.parse(modelText) : {}; }
          catch { return json({ success: false, error: "OpenRouter models returned invalid JSON." }, 502); }
          const rawModels = Array.isArray(modelJSON?.data) ? modelJSON.data : [];
          const models = rawModels
            .filter(m => String(m?.id || "").endsWith(":free"))
            .map(m => ({
              id: String(m.id),
              name: String(m.name || m.id),
              context_length: Number(m.context_length || 0),
              description: String(m.description || "")
            }))
            .sort((a,b) => a.name.localeCompare(b.name));
          return json({ success: true, refreshedAt: Date.now(), models });
        } catch (error) {
          return json({ success: false, error: "Could not load OpenRouter free models.", details: String(error?.message || error) }, 502);
        }
      }

/* =====================================================
         AI CHAT
         POST /chat
      ===================================================== */
      if (
        path === "/chat" &&
        request.method === "POST"
      ) {
        const body = await safeJSON(request);
        const prompt = String(body?.prompt || "").trim();
        const language = String(body?.language || "auto");
        let chatId = String(body?.chatId || "").trim();
        const projectId = String(body?.projectId || "").trim();

        const requestedModel = String(body?.model || "openrouter/free").trim();
        if (requestedModel !== "openrouter/free" && !requestedModel.endsWith(":free")) {
          return json({ success: false, error: "Only OpenRouter free models are allowed." }, 400);
        }
        const selectedModel = requestedModel || "openrouter/free";

        if (!prompt) { return json({error:"Prompt empty"},400); }
        const openRouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method:"POST", headers:{"Authorization":"Bearer "+env.OPENROUTER_API_KEY,"Content-Type":"application/json"},
          body: JSON.stringify({model: selectedModel, messages: []})
        });
        const answer = "ok"; const appliedFiles=[];
        return json({ success:true, chatId, answer,

          model: selectedModel,

          filesUpdated: appliedFiles,
          usage: { totalTokens: 0 }
        });
      }
      /* =====================================================
         USAGE
      ===================================================== */
      if(path==="/usage") return json({});
}}
function safeJSON(r){return r.json()}
function json(x,s=200){return new Response(JSON.stringify(x),{status:s})}
