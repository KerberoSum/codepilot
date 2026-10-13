import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import texmath from 'markdown-it-texmath';
import temml from 'temml';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import diff from 'highlight.js/lib/languages/diff';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';

for (const [name, fn] of Object.entries({javascript,typescript,python,json,bash,powershell,xml,css,sql,markdown,yaml,diff,java,csharp,cpp})) {
  hljs.registerLanguage(name,fn);
}
for(const [alias, name] of Object.entries({js:'javascript',ts:'typescript',sh:'bash',shell:'bash',zsh:'bash',ps1:'powershell',ps:'powershell',html:'xml',svg:'xml',md:'markdown',yml:'yaml',cs:'csharp',c:'cpp',h:'cpp',hpp:'cpp',py:'python',jsx:'javascript',tsx:'typescript'})) {
  hljs.registerAliases([alias],{languageName:name});
}
const md = new MarkdownIt({html:false,linkify:true,breaks:true,typographer:false});
md.use(taskLists,{enabled:false});
md.use(texmath,{engine:temml,delimiters:['dollars','brackets'],outerSpace:false,katexOptions:{trust:false,throwOnError:false,macros:{}}});
// MathML requires no network fonts other than optional Temml script glyphs. Incompatible TeX is displayed as its original source.
const escape = md.utils.escapeHtml;
const copyHeader = (label) => '<div class="codehead"><span>' + escape(label||'code') + '</span><button type="button" class="copy-btn" aria-label="Copy code">Copy</button></div>';
const codeBox=(text,language='')=>{
  const raw = String(text||'');
  const label = String(language||'').split(/\s+/)[0].toLowerCase();
  const recognized = hljs.getLanguage(label);
  let codeHtml = escape(raw);
  if(recognized){
    try {codeHtml=hljs.highlight(raw,{language:label,ignoreIllegals:true}).value;}catch{}
  }
  return '<div class="codebox">' + copyHeader(label) + '<pre><code class="hljs">' + codeHtml + '</code></pre></div>';
};
// Keep tables readable for providers that return aligned text within plain fenced blocks.
function plainGrid(value,strict=false){
  const lines = String(value||'').replace(/\r\n?/g,'\n').split('\n').map(x=>x.trimEnd()).filter(x=>x.trim());
  if(lines.length<2)return null;
  const isBorder=x=>/^\s*\+[+\-=:\s]+\+\s*$/.test(x)||/^\s*[-=]{3,}(?:\s+[-=]{3,})+\s*$/.test(x);
  const meaningful=lines.filter(x=>!isBorder(x));
  if(meaningful.length<2)return null;
  let rows, explicit=false;
  if(meaningful.every(x=>x.includes('|'))){
    explicit=true;
    rows=meaningful.map(line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(s=>s.trim()));
  }else if(meaningful.every(x=>x.includes('\t'))){
    explicit=true;
    rows=meaningful.map(line=>line.trim().split(/\t+/).map(s=>s.trim()));
  }else{
    rows=meaningful.map(line=>line.trim().split(/\s{2,}/).map(s=>s.trim()));
  }
  const separator=rows.length>1&&rows[1].length>1&&rows[1].every(s=>/^:?-{3,}:?$/.test(s));
  if(separator){rows.splice(1,1);explicit=true;}
  const cols=rows[0]?.length;
  if(!cols||cols<2||rows.length<2||rows.some(row=>row.length!==cols))return null;
  if((!explicit||strict&&!separator)&&rows.length<3)return null;
  return {head:rows[0],rows:rows.slice(1)};
}
function renderGrid(grid){
  const cells = (values,tag)=>'<tr>'+values.map(v=>'<'+tag+'>'+md.renderInline(String(v))+'</'+tag+'>').join('')+'</tr>';
  return '<div class="markdown-table-wrap"><table class="markdown-table"><thead>'+cells(grid.head,'th')+'</thead><tbody>'+grid.rows.map(row=>cells(row,'td')).join('')+'</tbody></table></div>';
}
md.renderer.rules.table_open = ()=>'<div class="markdown-table-wrap"><table class="markdown-table">';
md.renderer.rules.table_close = ()=>'</table></div>';
md.renderer.rules.hr=()=>'<hr class="md-hr">';
md.renderer.rules.fence=(tokens,idx,options,env,self)=>{
  const token=tokens[idx],lang=(token.info||'').trim().split(/\s+/)[0].toLowerCase();
  if(lang==='md'||lang==='markdown')return md.render(token.content);
  if(['','txt','text','plaintext','plain','table'].includes(lang)){
    const grid=plainGrid(token.content);
    if(grid)return renderGrid(grid);
  }
  return codeBox(token.content,lang);
};
md.renderer.rules.code_block=(tokens,idx)=>codeBox(tokens[idx].content,'text');
// A strict detection pass, only upgrading entire multi-line aligned paragraphs into grids.
// Regular prose, tables and inline code are unaffected.
md.core.ruler.after('inline','codepilot-plain-grid',state=>{
  const tokens=state.tokens;
  for(let i=0;i<tokens.length-2;i++){
    if(tokens[i].type!=='paragraph_open'||tokens[i+1].type!=='inline'||tokens[i+2].type!=='paragraph_close')continue;
    const raw=tokens[i+1].content;
    if(raw.indexOf('\n')<0)continue;
    const grid=plainGrid(raw,true);
    if(!grid)continue;
    const replacement=new state.Token('html_block','',0);
    replacement.content=renderGrid(grid)+'\n';
    tokens.splice(i,3,replacement);
  }
});
const originalLinkOpen=md.renderer.rules.link_open || ((tokens,idx,options,env,self)=>self.renderToken(tokens,idx,options));
md.renderer.rules.link_open=(tokens,idx,options,env,self)=>{
  tokens[idx].attrSet('target','_blank');
  tokens[idx].attrSet('rel','noopener noreferrer');
  return originalLinkOpen(tokens,idx,options,env,self);
};
const safe=(text)=>md.render(String(text||'').replace(/\r\n?/g,'\n'));
window.CodePilotMarkdown=Object.freeze({
  render:safe,
  renderInto:(parent,text)=>{
    const root=document.createElement('div');
    root.className='msg-text';
    root.innerHTML=safe(text);
    parent.appendChild(root);
    return root;
  },
  copyCode:async(button)=>{
    const code=button.closest('.codebox')?.querySelector('pre code');
    if(!code)return false;
    const text=code.textContent||'';
    try{await navigator.clipboard.writeText(text);return true;}catch{
      const range=document.createRange();range.selectNodeContents(code);
      const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
      try{const ok=document.execCommand('copy');selection?.removeAllRanges();return ok;}catch{return false;}
    }
  }
});
document.addEventListener('click',async(event)=>{
  const button=event.target.closest?.('.codebox .copy-btn');
  if(!button)return;
  const ok=await window.CodePilotMarkdown.copyCode(button);
  const old=button.textContent;
  button.textContent=ok?'Copied':'Select code';
  window.setTimeout(()=>{button.textContent=old;},1100);
});
