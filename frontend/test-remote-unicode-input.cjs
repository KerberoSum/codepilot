#!/usr/bin/env node
"use strict";
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),assert=require("node:assert/strict");
const html=fs.readFileSync(path.join(__dirname,"index.html"),"utf8");
function segment(start,end){
 const a=html.indexOf(start),b=html.indexOf(end,a);
 assert.ok(a>=0&&b>a,"Missing "+start); return html.slice(a,b);
}
const source=segment("async function sendRemoteUnicodeText(","function setWorkerIndicator(");
function harness(){
  const messages=[],timers=[];
  let now=10000;
  const proxy={id:"remoteKeyboardProxy",value:"",style:{},focused:false,focus(){this.focused=true;}};
  const input={value:""};
  const stage={getBoundingClientRect:()=>({left:20,top:30}),scrollLeft:0,scrollTop:0,focus(){}};
  const ctx=vm.createContext({
    Array,Date:{now:()=>now},Promise,setTimeout:(fn)=>{timers.push(fn);return timers.length;},
    remoteProxyComposing:false,remoteProxyCompositionEndedAt:0,remoteTextCompositionEndedAt:0,
    vmActivePage:"remote",remoteViewOnly:false,
    remoteInputQueue:Promise.resolve(),
    flushRemotePendingClick(){},sendRemoteInput:async payload=>{messages.push(payload);return {ok:true};},
    sendRemoteKey:async key=>{messages.push({type:"key",key});return {ok:true};},
    sendRemoteChord:async keys=>{messages.push({type:"chord",keys});return {ok:true};},
    scheduleRemoteScreen(){},
    document:{getElementById(id){if(id==="remoteKeyboardProxy")return proxy;if(id==="remoteTextInput")return input;if(id==="remoteStage")return stage;return null;}},
  });
  vm.runInContext(source,ctx);
  return {ctx,proxy,input,messages,timers,tick:ms=>{now+=ms;},flush:()=>{while(timers.length)timers.shift()();}};
}
let count=0;
async function check(name,fn){
  try{await fn();count++;console.log("PASS",name);}
  catch(e){console.error("FAIL",name,e.stack||e);process.exitCode=1;}
}
async function main(){
await check("Traditional Chinese and emoji delivered unchanged",async()=>{
 const h=harness();await h.ctx.sendRemoteUnicodeText("繁體中文：香港臺灣😊");
 assert.equal(h.messages.length,1);
 assert.equal(h.messages[0].text,"繁體中文：香港臺灣😊");
});
await check("Long Unicode text split by code point not surrogate pair",async()=>{
 const h=harness();const value="漢".repeat(399)+"😊"+"臺".repeat(402);
 await h.ctx.sendRemoteUnicodeText(value);
 assert.equal(h.messages.length,3);
 assert.equal(h.messages.map(x=>x.text).join(""),value);
 assert.equal(Array.from(h.messages[0].text).length,400);
});
await check("IME intermediate input ignored, committed result sent once",async()=>{
 const h=harness();const e={currentTarget:h.proxy,isComposing:true};
 h.ctx.remoteProxyCompositionStart();
 h.proxy.value="ㄓㄨㄥ";
 h.ctx.remoteProxyInput(e);assert.equal(h.messages.length,0);
 h.proxy.value="繁體中文";
 h.ctx.remoteProxyCompositionEnd({currentTarget:h.proxy,isComposing:false});
 h.flush();await Promise.resolve();
 assert.equal(h.messages.length,1);
 assert.equal(h.messages[0].text,"繁體中文");
 h.ctx.remoteProxyInput({currentTarget:h.proxy,isComposing:false});
 assert.equal(h.messages.length,1);
});
await check("Normal typing through input proxy not duplicated",async()=>{
 const h=harness();h.proxy.value="ABC";
 h.ctx.remoteProxyInput({currentTarget:h.proxy,isComposing:false});
 await Promise.resolve();assert.equal(h.messages.length,1);
 assert.equal(h.messages[0].text,"ABC");
});
await check("Send text field keeps value until acknowledged",async()=>{
 const h=harness();h.input.value="香港地鐵";
 await h.ctx.sendRemoteText({focus:false});
 assert.equal(h.messages.length,1);
 assert.equal(h.messages[0].text,"香港地鐵");
 assert.equal(h.input.value,"");
});
await check("IME Enter commit does not send remote Return",async()=>{
 const h=harness();let prevented=false;
 h.ctx.remoteTextCompositionEnd();
 await h.ctx.remoteTextKeydown({key:"Enter",isComposing:false,keyCode:13,preventDefault(){prevented=true;}});
 assert.equal(h.messages.length,0);
 assert.equal(prevented,false);
});
await check("Remote keyboard focus follows desktop click for IME",async()=>{
 const h=harness();
 h.ctx.focusRemoteKeyboard({clientX:220,clientY:280});
 assert.equal(h.proxy.focused,true);
 assert.equal(h.proxy.style.left,"200px");
 assert.equal(h.proxy.style.top,"250px");
});
if(!process.exitCode)console.log("All",count,"Unicode input frontend tests passed.");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
