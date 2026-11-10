#!/usr/bin/env node
"use strict";
// CodePilot Remote Screen pointer and Turbo queue regression tests.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const html=fs.readFileSync(path.join(__dirname,"index.html"),"utf8");
function segment(from,to){
  const start=html.indexOf(from),end=html.indexOf(to,start);
  assert.ok(start>=0 && end>start,"Could not extract "+from);
  return html.slice(start,end);
}
const gestureCode=segment("function remoteButton(e)","function remoteWheel(e)");
const cancelCode=segment("function cancelRemotePendingClick()","function closeRemoteSocket()");
let tests=0;

function pointerHarness(){
  let clock=1000,timerId=0;
  const timers=new Map(),events=[];
  const control={textContent:""},stage={focus(){}};
  const ctx=vm.createContext({
    Math,Promise,Date:{now:()=>clock},
    setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,at:clock+delay});return id;},
    clearTimeout(id){timers.delete(id);},
    document:{getElementById(id){return id==="remoteDoubleClickButton"?control:stage;}},
    setRemoteScreenStatus(){},
    focusRemoteKeyboard(){},
    sendRemoteInput(payload){events.push(payload);return Promise.resolve({ok:true});},
    remotePoint(e){return e.point;},
    remoteViewOnly:false, remotePointerActive:false,remotePointerDrag:false,
    remotePointerStart:null,remotePointerLast:null,remotePointerButton:1,
    remotePendingMove:null,remoteMoveTimer:null,remotePendingClick:null,
    remoteTurboActive:true,remoteDoubleClickArmed:false
  });
  vm.runInContext(cancelCode+gestureCode,ctx);
  function e(point={x:0.2,y:0.4},button=0){
    return {point,button,pointerId:1,preventDefault(){},currentTarget:{
      setPointerCapture(){},releasePointerCapture(){}
    }};
  }
  function tap(point,button=0){
    ctx.remotePointerDown(e(point,button));
    ctx.remotePointerUp(e(point,button));
  }
  function tick(ms){
    clock+=ms;
    for(const [id,task] of [...timers])if(task.at<=clock){
      timers.delete(id);task.fn();
    }
  }
  return {ctx,events,tap,e,tick,control};
}

function check(name,fn){
  try{fn();tests++;console.log("PASS",name);}
  catch(error){console.error("FAIL",name,error);process.exitCode=1;}
}

check("Single click is one atomic click",()=>{
  const h=pointerHarness();
  h.tap();
  assert.equal(h.events.length,0);
  h.tick(451);
  assert.deepEqual(h.events.map(x=>x.type),["click"]);
});

check("Two taps produce one double-click, never 4 clicks",()=>{
  const h=pointerHarness();
  h.tap();h.tick(200);h.tap();
  h.ctx.remoteDoubleClick({preventDefault(){}});
  h.tick(500);
  assert.deepEqual(h.events.map(x=>x.type),["double_click"]);
});

check("Right-click does not wait",()=>{
  const h=pointerHarness();
  h.tap({x:0.3,y:0.5},2);
  assert.equal(h.events.length,1);
  assert.equal(h.events[0].button,3);
  assert.equal(h.events[0].type,"click");
});

check("Double-click-next sends a double-click on one tap",()=>{
  const h=pointerHarness();
  h.ctx.armRemoteDoubleClick();
  assert.equal(h.control.textContent,"Cancel double-click");
  h.tap();
  assert.deepEqual(h.events.map(x=>x.type),["double_click"]);
  assert.equal(h.control.textContent,"Double-click next");
});

check("Small pointer movement is still a click",()=>{
  const h=pointerHarness();
  h.ctx.remotePointerDown(h.e());
  h.ctx.remotePointerMove(h.e({x:0.203,y:0.4005}));
  h.ctx.remotePointerUp(h.e());
  h.tick(451);
  assert.deepEqual(h.events.map(x=>x.type),["click"]);
});

check("Dragging delivers mouse-down, move, mouse-up in order",()=>{
  const h=pointerHarness();
  h.ctx.remotePointerDown(h.e());
  h.ctx.remotePointerMove(h.e({x:0.25,y:0.40}));
  h.ctx.remotePointerUp(h.e({x:0.26,y:0.40}));
  h.tick(500);
  assert.deepEqual(h.events.map(x=>x.type),["mouse_down","move","mouse_up"]);
});

check("Pointer cancellation releases an active drag",()=>{
  const h=pointerHarness();
  h.ctx.remotePointerDown(h.e());
  h.ctx.remotePointerMove(h.e({x:0.25,y:0.40}));
  h.ctx.remotePointerCancel(h.e({x:0.25,y:0.40}));
  assert.deepEqual(h.events.map(x=>x.type),["mouse_down","mouse_up"]);
});

async function turboQueueCheck(){
  const queueCode=segment("async function sendRemoteInputNow(","function remotePoint(e)");
  const ackCode=segment("function settleRemoteInputAck(","function cancelRemotePendingClick()");
  let inflight=0,maxInFlight=0,calls=0;
  const ctx=vm.createContext({
    remoteViewOnly:false,remoteTurboActive:true,remoteInputQueue:Promise.resolve(),
    remoteInputAck:null,remoteSocket:null,vmActivePage:"agent",remoteScreenTimer:null,
    WebSocket:{OPEN:1},markRemoteInteraction(){},setRemoteScreenStatus(){},
    fallbackRemoteToHttps(){throw Error("unexpected HTTPS fallback");},
    JSON,Promise,setTimeout,clearTimeout,
    API_BASE_URL:"https://invalid.example",authToken:"unused",
    fetch(){throw Error("should not use HTTP");}
  });
  ctx.remoteSocket={readyState:1,send(){
    calls++;inflight++;maxInFlight=Math.max(inflight,maxInFlight);
    setImmediate(()=>{inflight--;ctx.settleRemoteInputAck();});
  }};
  vm.runInContext(ackCode+queueCode,ctx);
  await Promise.all([
    ctx.sendRemoteInput({type:"click",x:0.1,y:0.1,button:1},{refresh:false}),
    ctx.sendRemoteInput({type:"key",key:"Enter"},{refresh:false}),
    ctx.sendRemoteInput({type:"click",x:0.2,y:0.2,button:1},{refresh:false})
  ]);
  assert.equal(calls,3);
  assert.equal(maxInFlight,1,"Only one Turbo input must await an ACK at a time");
  console.log("PASS Turbo input queue waits for ACK before next action");
  tests++;
}
turboQueueCheck().then(()=>{
  if(!process.exitCode)console.log("All",tests,"Remote Screen input tests passed.");
}).catch(e=>{console.error("FAIL Turbo ACK test",e);process.exitCode=1;});
