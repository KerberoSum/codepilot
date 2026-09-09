from pathlib import Path
import re, shutil, sys, datetime

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
FRONT = ROOT / 'frontend' / 'index.html'
WORKER = ROOT / 'worker' / 'src' / 'index.js'

for p in (FRONT, WORKER):
    if not p.exists():
        raise SystemExit(f'Missing required file: {p}')

stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
for p in (FRONT, WORKER):
    shutil.copy2(p, p.with_suffix(p.suffix + f'.bak_{stamp}'))

front = FRONT.read_text(encoding='utf-8')
worker = WORKER.read_text(encoding='utf-8')


def replace_js_function(src: str, name: str, replacement: str) -> str:
    m = re.search(rf'function\s+{re.escape(name)}\s*\([^)]*\)\s*\{{', src)
    if not m:
        raise RuntimeError(f'Could not find function {name}()')
    brace = src.find('{', m.start())
    depth = 0
    quote = None
    esc = False
    line_comment = False
    block_comment = False
    i = brace
    while i < len(src):
        c = src[i]
        n = src[i+1] if i+1 < len(src) else ''
        if line_comment:
            if c == '\n': line_comment = False
        elif block_comment:
            if c == '*' and n == '/': block_comment = False; i += 1
        elif quote:
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == quote: quote = None
        else:
            if c == '/' and n == '/': line_comment = True; i += 1
            elif c == '/' and n == '*': block_comment = True; i += 1
            elif c in ('\"', "'", '`'): quote = c
            elif c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return src[:m.start()] + replacement.rstrip() + src[i+1:]
        i += 1
    raise RuntimeError(f'Unbalanced braces while replacing {name}()')

# ---------------- FRONTEND ----------------
# Add CSS variables for accessibility.
if '--chat-font-size:' not in front:
    front = front.replace('--yellow:#f1c75b;--red:#ff667d;--editor:#090d13;',
        '--yellow:#f1c75b;--red:#ff667d;--editor:#090d13;--chat-font-size:11px;--chat-font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;')

# Add Markdown/accessibility/model CSS before RESIZERS (or MODALS fallback).
if '.md-table-wrap' not in front:
    css = r'''
/* CODEPILOT v2.1 — MARKDOWN / ACCESSIBILITY / MODELS */
.msg-text{font-size:var(--chat-font-size);font-family:var(--chat-font-family);line-height:1.6;color:#e2e7ee;overflow-wrap:anywhere;white-space:normal}
.msg-text p{margin:0 0:.72em}.msg-text p:last-child{margin-bottom:0}
.msg-text h1,.msg-text h2,.msg-text h3,.msg-text h4{color:#fff;line-height:1.3;margin:.9em 0 .45em}
.msg-text h1{font-size:1.55em}.msg-text h2{font-size:1.35em}.msg-text h3{font-size:1.18em}.msg-text h4{font-size:1.05em}
.msg-text strong{color:#fff}.msg-text em{color:#d8deea}.msg-text ul,.msg-text ol{margin:.45em 0 .75em;padding-left:1.55em}.msg-text li{margin:.25em 0}
.msg-text blockquote{margin:.65em 0;padding:.3em .8em;border-left:3px solid var(--accent);color:#bdc7d5;background:rgba(116,87,255,.06)}
.msg-text code{font-family:"SFMono-Regular",Consolas,monospace;font-size:.9em;background:#070a0f;border:1px solid var(--border2);border-radius:4px;padding:.08em .32em}
.msg-text a{color:#93b9ff;text-decoration:underline}.md-table-wrap{width:100%;overflow-x:auto;margin:.7em 0}
.md-table{width:100%;border-collapse:collapse;font-size:.92em}.md-table th,.md-table td{border:1px solid var(--border);padding:6px 8px;text-align:left;vertical-align:top}
.md-table th{background:var(--panel3);color:#fff;font-weight:700}.md-table tr:nth-child(even) td{background:rgba(255,255,255,.015)}
.ai-settings{display:flex;align-items:center;gap:7px;padding:6px 10px;border-bottom:1px solid var(--border2);background:#0a0f16;min-height:38px}
.ai-settings-label{font-size:9px;color:var(--muted2);margin-right:auto}.a11y-select{border:1px solid var(--border);background:var(--panel2);color:#fff;border-radius:7px;padding:5px 7px;font-size:9px;min-width:88px;outline:0}
.a11y-select:focus{border-color:var(--accent)}.model-select{min-width:120px;max-width:220px;flex:1;border:1px solid var(--border);background:var(--panel3);color:#fff;border-radius:7px;padding:6px;font-size:9px;outline:0}
.model-select:focus{border-color:var(--accent)}.model-refresh{border:1px solid var(--border);background:var(--panel3);color:var(--muted);border-radius:7px;padding:5px 7px;font-size:10px}.model-refresh:hover{color:#fff}
'''
    anchor = '/* RESIZERS */' if '/* RESIZERS */' in front else '/* MODALS */'
    front = front.replace(anchor, css + '\n' + anchor, 1)

# Add accessibility bar below AI header.
if 'id="chatFontSize"' not in front:
    ai_header_end = re.search(r'(</header>\s*<div id="chatArea" class="chat-area">)', front)
    if not ai_header_end:
        raise RuntimeError('Could not find AI header/chat area insertion point')
    bar = '''</header>\n  <div class="ai-settings" aria-label="Chat display settings">\n    <span class="ai-settings-label">Display</span>\n    <select id="chatFontSize" class="a11y-select" onchange="applyChatFontSize(this.value)" title="Chat font size" aria-label="Chat font size">\n      <option value="11">Small</option><option value="13" selected>Medium</option><option value="16">Large</option><option value="19">Extra large</option>\n    </select>\n    <select id="chatFontStyle" class="a11y-select" onchange="applyChatFontStyle(this.value)" title="Chat font style" aria-label="Chat font style">\n      <option value="system" selected>System</option><option value="readable">Readable</option><option value="serif">Serif</option><option value="mono">Mono</option>\n    </select>\n  </div>\n  <div id="chatArea" class="chat-area">'''
    front = front[:ai_header_end.start()] + bar + front[ai_header_end.end():]

# Add model selector to composer before language selector.
if 'id="modelSelect"' not in front:
    language_select = re.search(r'(<select\s+id="language"\s+class="lang")', front)
    if not language_select:
        raise RuntimeError('Could not find language selector')
    model_ui = '''<select id="modelSelect" class="model-select" title="OpenRouter free model" aria-label="OpenRouter free model">\n          <option value="openrouter/free">Free Auto Router</option>\n        </select>\n        <button type="button" class="model-refresh" onclick="loadFreeModels(true)" title="Refresh free models" aria-label="Refresh free model list">↻</button>\n        '''
    front = front[:language_select.start()] + model_ui + front[language_select.start():]

# Replace renderAIText with a safe lightweight Markdown renderer and helpers.
markdown_block = r'''function renderAIText(parent,text){
  const root=document.createElement("div");root.className="msg-text";
  renderMarkdownInto(root,String(text||""));parent.appendChild(root);
}

function renderMarkdownInto(root,source){
  const lines=String(source||"").replace(/\r\n?/g,"\n").split("\n");
  let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    const fence=line.match(/^\s*```([^`]*)\s*$/);
    if(fence){
      const lang=(fence[1]||"code").trim()||"code",buf=[];i++;
      while(i<lines.length && !/^\s*```\s*$/.test(lines[i])){buf.push(lines[i]);i++;}
      if(i<lines.length)i++;
      root.appendChild(makeMarkdownCodeBox(lang,buf.join("\n")));continue;
    }
    if(i+1<lines.length && isTableRow(line) && isTableDivider(lines[i+1])){
      const rows=[splitTableRow(line)];i+=2;
      while(i<lines.length && isTableRow(lines[i]) && lines[i].trim()){rows.push(splitTableRow(lines[i]));i++;}
      root.appendChild(makeMarkdownTable(rows));continue;
    }
    const heading=line.match(/^\s*(#{1,4})\s+(.+)$/);
    if(heading){const h=document.createElement("h"+heading[1].length);h.innerHTML=inlineMarkdown(heading[2]);root.appendChild(h);i++;continue;}
    if(/^\s*>\s?/.test(line)){
      const q=[];while(i<lines.length && /^\s*>\s?/.test(lines[i])){q.push(lines[i].replace(/^\s*>\s?/,""));i++;}
      const b=document.createElement("blockquote");b.innerHTML=inlineMarkdown(q.join("\n")).replace(/\n/g,"<br>");root.appendChild(b);continue;
    }
    if(/^\s*[-*+]\s+/.test(line)){
      const ul=document.createElement("ul");
      while(i<lines.length && /^\s*[-*+]\s+/.test(lines[i])){const li=document.createElement("li");li.innerHTML=inlineMarkdown(lines[i].replace(/^\s*[-*+]\s+/,""));ul.appendChild(li);i++;}
      root.appendChild(ul);continue;
    }
    if(/^\s*\d+[.)]\s+/.test(line)){
      const ol=document.createElement("ol");
      while(i<lines.length && /^\s*\d+[.)]\s+/.test(lines[i])){const li=document.createElement("li");li.innerHTML=inlineMarkdown(lines[i].replace(/^\s*\d+[.)]\s+/,""));ol.appendChild(li);i++;}
      root.appendChild(ol);continue;
    }
    const para=[];
    while(i<lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s*(#{1,4})\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !(i+1<lines.length && isTableRow(lines[i]) && isTableDivider(lines[i+1]))){para.push(lines[i]);i++;}
    const p=document.createElement("p");p.innerHTML=inlineMarkdown(para.join("\n")).replace(/\n/g,"<br>");root.appendChild(p);
  }
}
function escapeHTML(v){return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;");}
function inlineMarkdown(text){
  const codes=[];let s=String(text||"").replace(/`([^`\n]+)`/g,(_,c)=>"@@CODE"+(codes.push(c)-1)+"@@");s=escapeHTML(s);
  s=s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s=s.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>").replace(/__([^_\n]+)__/g,"<strong>$1</strong>");
  s=s.replace(/~~([^~\n]+)~~/g,"<del>$1</del>").replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,"$1<em>$2</em>");
  s=s.replace(/@@CODE(\d+)@@/g,(_,n)=>"<code>"+escapeHTML(codes[Number(n)]||"")+"</code>");return s;
}
function isTableRow(line){return /\|/.test(line||"");}
function isTableDivider(line){const cells=splitTableRow(line);return cells.length>0 && cells.every(c=>/^:?-{3,}:?$/.test(c.trim()));}
function splitTableRow(line){let s=String(line||"").trim();if(s.startsWith("|"))s=s.slice(1);if(s.endsWith("|"))s=s.slice(0,-1);return s.split("|").map(x=>x.trim());}
function makeMarkdownTable(rows){
  const wrap=document.createElement("div");wrap.className="md-table-wrap";const table=document.createElement("table");table.className="md-table";
  const thead=document.createElement("thead"),trh=document.createElement("tr");(rows[0]||[]).forEach(c=>{const th=document.createElement("th");th.innerHTML=inlineMarkdown(c);trh.appendChild(th)});thead.appendChild(trh);table.appendChild(thead);
  if(rows.length>1){const tbody=document.createElement("tbody");rows.slice(1).forEach(r=>{const tr=document.createElement("tr");r.forEach(c=>{const td=document.createElement("td");td.innerHTML=inlineMarkdown(c);tr.appendChild(td)});tbody.appendChild(tr)});table.appendChild(tbody);}wrap.appendChild(table);return wrap;
}
function makeMarkdownCodeBox(lang,code){
  const box=document.createElement("div");box.className="codebox";const h=document.createElement("div");h.className="codehead";const l=document.createElement("span");l.textContent=lang||"code";const b=document.createElement("button");b.className="copy-btn";b.textContent="Copy";b.type="button";const pre=document.createElement("pre");pre.textContent=code||"";
  b.onclick=async()=>{try{await navigator.clipboard.writeText(pre.innerText);b.textContent="Copied";setTimeout(()=>b.textContent="Copy",1000)}catch{const r=document.createRange();r.selectNodeContents(pre);const s=window.getSelection();s.removeAllRanges();s.addRange(r)}};h.append(l,b);box.append(h,pre);return box;
}'''
front = replace_js_function(front, 'renderAIText', markdown_block)

# Insert accessibility/model functions before SEND AI or before sendMessage.
if 'function loadFreeModels(' not in front:
    functions = r'''
/* =========================================================
   ACCESSIBILITY + OPENROUTER FREE MODELS
========================================================= */
function applyChatFontSize(value){const n=Math.min(22,Math.max(10,Number(value)||13));document.documentElement.style.setProperty("--chat-font-size",n+"px");}
function applyChatFontStyle(value){
  const fonts={system:'Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',readable:'Verdana,Tahoma,Arial,sans-serif',serif:'Georgia,"Times New Roman",serif',mono:'"SFMono-Regular",Consolas,"Liberation Mono",monospace'};
  document.documentElement.style.setProperty("--chat-font-family",fonts[value]||fonts.system);
}
async function loadFreeModels(showStatus=false){
  const select=document.getElementById("modelSelect");if(!select)return;const previous=select.value||"openrouter/free";
  if(showStatus)setStatus("Refreshing free models…");
  try{
    const d=await api("/models");const models=Array.isArray(d.models)?d.models:[];select.innerHTML="";
    const auto=document.createElement("option");auto.value="openrouter/free";auto.textContent="Free Auto Router";select.appendChild(auto);
    models.filter(m=>m&&m.id&&m.id!=="openrouter/free").sort((a,b)=>String(a.name||a.id).localeCompare(String(b.name||b.id))).forEach(m=>{const o=document.createElement("option");o.value=m.id;const ctx=Number(m.context_length||m.contextLength||0);o.textContent=(m.name||m.id)+(ctx?" · "+formatContext(ctx):"");select.appendChild(o);});
    if([...select.options].some(o=>o.value===previous))select.value=previous;select.title=models.length?"Live OpenRouter free model list":"Free Auto Router";
    if(showStatus)flashStatus("Free models refreshed ("+models.length+")");
  }catch(e){select.innerHTML='<option value="openrouter/free">Free Auto Router</option>';select.title="Free model list unavailable; auto free routing still works.";if(showStatus)flashStatus("Model list unavailable");console.warn(e);}
}
function formatContext(n){if(n>=1000000)return (n/1000000).toFixed(n%1000000?1:0)+"M ctx";if(n>=1000)return Math.round(n/1000)+"K ctx";return n+" ctx";}
'''
    m = re.search(r'async\s+function\s+sendMessage\s*\(', front)
    if not m: raise RuntimeError('Could not find sendMessage()')
    front = front[:m.start()] + functions + '\n' + front[m.start():]

# Ensure init loads model list and default accessibility settings.
init_match = re.search(r'async\s+function\s+init\s*\(\)\s*\{', front)
if init_match and 'loadFreeModels(false)' not in front[init_match.start():init_match.start()+1200]:
    pos = front.find('{', init_match.start()) + 1
    front = front[:pos] + '\n  applyChatFontSize(document.getElementById("chatFontSize")?.value||13);\n  applyChatFontStyle(document.getElementById("chatFontStyle")?.value||"system");' + front[pos:]
    # Load models after the initial backend loads, non-blocking/failure-safe.
    marker = 'await Promise.all([loadProjects(),loadChats(),loadUsage()]);'
    if marker in front:
        front = front.replace(marker, marker + '\n    loadFreeModels(false);', 1)
    else:
        # fallback: call after health succeeds at start
        marker2 = 'setStatus("Ready");'
        front = front.replace(marker2, 'loadFreeModels(false);\n    '+marker2, 1)

# Add model to /chat payload if absent.
send_start = re.search(r'async\s+function\s+sendMessage\s*\(', front)
if not send_start: raise RuntimeError('Could not find sendMessage()')
# modify only if no model selector reference exists inside sendMessage
send_slice = front[send_start.start():]
if 'model:document.getElementById("modelSelect")' not in send_slice[:5000]:
    pat = r'(language\s*:\s*document\.getElementById\("language"\)\.value)\s*}'
    repl = r'\1,model:document.getElementById("modelSelect")?.value||"openrouter/free"}'
    front2, n = re.subn(pat, repl, front, count=1)
    if n != 1: raise RuntimeError('Could not add selected model to /chat payload')
    front = front2

# Bump visible version strings conservatively.
front = re.sub(r'CodePilot v2\.0(?=[<"`])', 'CodePilot v2.1', front)

# ---------------- WORKER ----------------
# Add GET /models route before AI CHAT.
if 'path === "/models"' not in worker:
    model_route = r'''
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

'''
    idx = worker.find('/* =====================================================\n         AI CHAT')
    if idx < 0:
        idx = worker.find('AI CHAT')
        if idx < 0: raise RuntimeError('Could not find AI CHAT route insertion point in Worker')
        idx = worker.rfind('/*', 0, idx)
    worker = worker[:idx] + model_route + worker[idx:]

# Add requested model parsing in POST /chat after projectId declaration area, before prompt validation.
chat_idx = worker.find('path === "/chat"')
if chat_idx < 0: raise RuntimeError('Could not find POST /chat route')
chat_end = worker.find('/* =====================================================\n         USAGE', chat_idx)
if chat_end < 0: chat_end = min(len(worker), chat_idx + 50000)
chat_block = worker[chat_idx:chat_end]
if 'const selectedModel' not in chat_block:
    # Put just before `if (!prompt)` to avoid dependence on formatting of previous declarations.
    prompt_if = re.search(r'\n\s*if\s*\(\s*!prompt\s*\)\s*\{', chat_block)
    if not prompt_if: raise RuntimeError('Could not find prompt validation inside /chat')
    insert_at = chat_idx + prompt_if.start()
    code = r'''

        const requestedModel = String(body?.model || "openrouter/free").trim();
        if (requestedModel !== "openrouter/free" && !requestedModel.endsWith(":free")) {
          return json({ success: false, error: "Only OpenRouter free models are allowed." }, 400);
        }
        const selectedModel = requestedModel || "openrouter/free";
'''
    worker = worker[:insert_at] + code + worker[insert_at:]

# Replace the hardcoded OpenRouter free router in chat completion with selectedModel.
chat_idx = worker.find('path === "/chat"')
openrouter_idx = worker.find('"https://openrouter.ai/api/v1/chat/completions"', chat_idx)
if openrouter_idx < 0: raise RuntimeError('Could not find OpenRouter chat completion request')
model_pos = worker.find('"openrouter/free"', openrouter_idx)
if model_pos < 0: raise RuntimeError('Could not find hard-coded openrouter/free model in chat request')
worker = worker[:model_pos] + 'selectedModel' + worker[model_pos+len('"openrouter/free"'):]

# Optionally expose the actual selected model in chat response for diagnostics.
resp_anchor = re.search(r'(answer\s*,\s*\n\s*filesUpdated\s*:)', worker[openrouter_idx:])
if resp_anchor:
    abspos = openrouter_idx + resp_anchor.start()
    seg = worker[abspos:abspos+300]
    if 'model:' not in seg:
        worker = worker[:abspos] + 'answer,\n\n          model: selectedModel,\n\n          filesUpdated:' + worker[openrouter_idx + resp_anchor.end():]

FRONT.write_text(front, encoding='utf-8')
WORKER.write_text(worker, encoding='utf-8')
print('Updated:')
print(' -', FRONT)
print(' -', WORKER)
print('Backups use suffix:', f'.bak_{stamp}')
print('\nNext: deploy the Worker first, then deploy the frontend.')
