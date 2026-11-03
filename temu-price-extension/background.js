'use strict';
let serial=Promise.resolve();
const allowed=url=>{try{const u=new URL(url);return u.protocol==='https:'&&['agentseller-us.temu.com','agentseller.temu.com'].includes(u.hostname);}catch{return false;}};
const load=()=>chrome.storage.local.get({records:{},job:null,errors:[]});
const save=s=>chrome.storage.local.set(s);
async function send(tabId,msg){
  try{return await chrome.tabs.sendMessage(tabId,msg);}
  catch{
    try{
      const tab=await chrome.tabs.get(tabId);if(!allowed(tab.url))return {error:'仅允许操作Temu商家页面'};
      await chrome.scripting.executeScript({target:{tabId},files:['parser.js','content.js']});
      return await chrome.tabs.sendMessage(tabId,msg);
    }catch(error){return {error:'页面连接失败：'+error.message};}
  }
}
function addError(s,order,reason){s.errors.push({order,reason,time:new Date().toISOString()});s.errors=s.errors.slice(-2000);}
function remember(s,result,month){
  if(month&&result.created&&result.created.slice(0,7)!==month){addError(s,result.order,'订单创建月份不符合选择月份，未采集');return;}
  for(const record of result.records||[]){
    const k=record.order+'|'+record.sku;const old=s.records[k];
    if(old&&(old.price!==record.price||old.currency!==record.currency)){
      addError(s,record.order,'SKU '+record.sku+' 与已保存价格冲突，保留旧值，请人工核对');continue;
    }
    s.records[k]={...record,created:result.created||'',month:result.created?.slice(0,7)||month||'',captured:new Date().toISOString(),source:result.url};
  }
  for(const error of result.errors||[])addError(s,result.order,error);
}
function detailTemplate(value,host){
  try{const u=new URL(value);if(!allowed(u.href)||u.hostname!==host||u.pathname!=='/mmsos/order-detail.html'||!/^PO-\d+-\d+$/.test(u.searchParams.get('parent_order_sn')||''))return null;return u.href;}catch{return null;}
}
const cancelled=value=>/^(?:已取消|cancelled|canceled)$/i.test(String(value||'').trim());
function createdMonth(value){const m=String(value||'').match(/^(\d{4})[-/](\d{1,2})[-/]\d{1,2}/);return m?m[1]+'-'+m[2].padStart(2,'0'):null;}
async function pausePlatform(s,reason){s.job.active=false;s.job.message=reason;addError(s,s.job.order||'',reason);await save(s);}
async function platformPage(s,page){
  const j=s.job,items=Array.isArray(page.items)?page.items:[];
  const orders=[...new Set([...(Array.isArray(page.orders)?page.orders:[]),...items.map(x=>x.order)].filter(o=>typeof o==='string'&&/^PO-\d+-\d+$/.test(o)))];
  if(!orders.length){await pausePlatform(s,'后台列表未读取到订单，请检查页面状态；未认定采集完成');return;}
  const signature=orders.join('|');
  if(j.stage==='page'&&signature===j.signature)return;
  j.signature=signature;j.pageCount=(j.pageCount||0)+1;
  j.pending=orders.filter(o=>{
    if(j.processed.includes(o))return false;
    const rows=items.filter(x=>x.order===o),known=rows.length===1?rows[0]:null;
    if(known&&cancelled(known.status)){j.processed.push(o);j.excludedCancelled=(j.excludedCancelled||0)+1;return false;}
    const month=known&&createdMonth(known.created);
    if(month&&month!==j.month){j.processed.push(o);j.excludedOtherMonth=(j.excludedOtherMonth||0)+1;return false;}
    return true;
  });
  j.index=0;j.stage='list';j.started=Date.now();await save(s);await drive(s);
}
async function drive(s){
  const j=s.job;if(!j?.active||j.stage!=='list')return;
  if(j.index>=j.pending.length){
    if(j.platform){
      j.stage='page';j.started=Date.now();await save(s);const next=await send(j.listTab,{type:'NEXT_PAGE'});
      if(!next.ok){
        if(next.finished===true){j.active=false;j.message='所选月份后台采集完成';const ownList=j.listTab;j.listTab=null;await save(s);if(ownList&&ownList!==j.base)try{await chrome.tabs.remove(ownList);}catch{}}
        else await pausePlatform(s,next.error||'后台未找到明确可用的下一页按钮，已暂停；未认定全部完成');
      }return;
    }
    if(j.quiet||!j.autoNext){j.active=false;j.message=j.quiet?'导入订单后台采集完成':'当前列表页完成';await save(s);return;}
    j.stage='page';j.started=Date.now();await save(s);
    const next=await send(j.base,{type:'NEXT_PAGE'});
    if(!next.ok){j.active=false;j.message='当前页完成；未找到唯一可用下一页按钮。可手动翻页后再次开始。';await save(s);}return;
  }
  j.order=j.pending[j.index];j.stage='detail';j.detail=j.quiet?null:j.base;j.started=Date.now();await save(s);
  if(j.quiet){
    try{const url=new URL(j.template);url.searchParams.set('parent_order_sn',j.order);const worker=await chrome.tabs.create({url:url.href,active:false});j.detail=worker.id;j.worker=worker.id;await save(s);}
    catch(error){j.active=false;j.message='后台详情页创建失败：'+error.message;addError(s,j.order,j.message);await save(s);}return;
  }
  const opened=await send(j.base,{type:'OPEN_ORDER',order:j.order});
  if(opened.error){j.active=false;j.message=opened.error;addError(s,j.order,opened.error);await save(s);}
}
async function handle(msg,sender){
  const s=await load(),j=s.job,tabId=sender.tab?.id;
  if(msg.type==='PAGE_STATUS')return {active:!!j?.active,accept:!!j&&(j.platform?[j.listTab,j.detail]:[j.base,j.detail]).includes(tabId),stage:j?.stage,order:j?.order};
  if(msg.type==='STATUS')return {job:j,count:Object.keys(s.records).length,errors:s.errors.slice(-8)};
  if(msg.type==='EXTENSION_UPDATE')return TemuExtensionUpdate(msg.operation);
  if(msg.type==='BRIDGE_STATUS')return typeof TemuBridgeStatus==='function'?TemuBridgeStatus():{configured:false,connected:false};
  if(msg.type==='BRIDGE_TOGGLE'){await chrome.storage.local.set({bridgeEnabled:!!msg.enabled});return {ok:true};}
  if(msg.type==='START_PLATFORM'){
    if(j?.active)throw Error('请先暂停已有采集任务');
    const tab=await chrome.tabs.get(msg.tabId);if(!allowed(tab.url)||new URL(tab.url).pathname!=='/mmsos/orders.html')throw Error('请在本店铺实际订单列表页开始后台采集');
    if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(msg.month||''))throw Error('请选择有效月份');
    const host=new URL(tab.url).hostname;let template;
    for(const r of Object.values(s.records)){template=detailTemplate(r.source,host);if(template)break;}
    if(!template){const tabs=await chrome.tabs.query({});for(const t of tabs){template=detailTemplate(t.url,host);if(template)break;}}
    const list=await chrome.tabs.create({url:tab.url,active:false});
    if(!template){
      const owned=new Set([list.id]);
      try{
        let first;
        for(let attempt=0;attempt<30;attempt++){
          const data=await send(list.id,{type:'LIST'});first=data.orders?.[0];
          if(first)break;await new Promise(resolve=>setTimeout(resolve,500));
        }
        if(!first)throw Error('后台订单列表未加载到详情入口，请检查登录状态');
        const opened=await send(list.id,{type:'OPEN_ORDER',order:first});
        if(opened.error)throw Error(opened.error);
        for(let attempt=0;attempt<30;attempt++){
          const candidates=await chrome.tabs.query({});
          for(const t of candidates){if(t.id===list.id||t.openerTabId===list.id){owned.add(t.id);template=detailTemplate(t.url,host);if(template)break;}}
          if(template)break;await new Promise(resolve=>setTimeout(resolve,500));
        }
        if(!template)throw Error('后台未取得真实详情地址，请检查平台是否阻止打开详情');
        for(const id of owned)if(id!==list.id)await chrome.tabs.remove(id);
        await chrome.tabs.update(list.id,{url:tab.url,active:false});
      }catch(error){for(const id of owned)try{await chrome.tabs.remove(id);}catch{}throw error;}
    }
    s.job={active:true,platform:true,quiet:true,base:tab.id,listTab:list.id,listURL:tab.url,detail:null,worker:null,template,month:msg.month,pending:[],index:0,processed:[],stage:'prepare',signature:null,pageCount:0,message:'准备后台全部状态订单列表',started:Date.now()};await save(s);return {ok:true};
  }
  if(msg.type==='START_IMPORTED'){
    const tab=await chrome.tabs.get(msg.tabId);if(!allowed(tab.url))throw Error('请在已登录的对应Temu店铺页面导入');
    if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(msg.month||'')||!Array.isArray(msg.orders)||!msg.orders.length||msg.orders.length>20000||!msg.orders.every(o=>typeof o==='string'&&/^PO-\d+-\d+$/.test(o)&&o.length<=80))throw Error('导入订单或月份无效');
    if(!msg.expectedSkus||typeof msg.expectedSkus!=='object'||Array.isArray(msg.expectedSkus))throw Error('缺少订单SKU清单');
    const expected={};for(const o of msg.orders){const ids=msg.expectedSkus[o];if(!Array.isArray(ids)||!ids.length||ids.length>1000||!ids.every(v=>typeof v==='string'&&/^\d{1,30}$/.test(v)))throw Error('订单SKU清单无效');expected[o]=[...new Set(ids)];}
    if(j?.active)throw Error('请先暂停已有采集任务');
    const host=new URL(tab.url).hostname;let template=detailTemplate(tab.url,host);
    if(!template)for(const record of Object.values(s.records)){template=detailTemplate(record.source,host);if(template)break;}
    if(!template)throw Error('请先手动打开本店铺任意订单详情或读取当前详情，以确认真实详情地址；不会猜测接口');
    s.job={active:true,quiet:true,imported:true,base:tab.id,detail:null,worker:null,template,expectedSkus:expected,month:msg.month,autoNext:false,pending:[...new Set(msg.orders)],index:0,processed:[],stage:'list',message:'正在后台采集导入订单',started:Date.now()};
    await save(s);await drive(s);return {ok:true};
  }
  if(msg.type==='START'){
    const tab=await chrome.tabs.get(msg.tabId);if(!allowed(tab.url))throw Error('请在已登录的Temu订单页面开始');
    if(!/^\d{4}-\d{2}$/.test(msg.month||''))throw Error('请选择订单月份，并先在平台筛选相同月份');
    const list=await send(tab.id,{type:'LIST'});
    if(!list.orders?.length)throw Error(list.error||'未找到订单详情入口；请回到订单列表，或使用“读取当前详情”');
    s.job={active:true,base:tab.id,detail:tab.id,month:msg.month,autoNext:!!msg.autoNext,pending:list.orders,index:0,processed:[],stage:'list',signature:list.orders.join('|'),message:'正在采集',started:Date.now()};
    await save(s);await drive(s);return {ok:true};
  }
  if(msg.type==='CAPTURE'){
    const tab=await chrome.tabs.get(msg.tabId);if(!allowed(tab.url))throw Error('请打开Temu订单详情');
    const result=await send(tab.id,{type:'CAPTURE_PAGE'});
    if(!result.records?.length)throw Error(result.error||result.errors?.join('；')||'未读取到价格');
    remember(s,result,'');await save(s);return {ok:true,count:result.records.length};
  }
  if(msg.type==='PAUSE'){
    if(j){j.active=false;j.message=msg.reason||'已暂停';await save(s);}return {ok:true};
  }
  if(msg.type==='RESUME'){
    if(!j)throw Error('尚无待续采任务');
    const tab=await chrome.tabs.get(msg.tabId);if(!allowed(tab.url))throw Error('请在对应店铺的订单列表或详情页继续');
    if(j.platform){
      if(new URL(tab.url).hostname!==new URL(j.template).hostname)throw Error('当前店铺域名与后台任务不一致');
      j.active=true;j.base=tab.id;j.started=Date.now();j.message='继续平台后台采集';
      let list;try{if(j.listTab)list=await chrome.tabs.get(j.listTab);}catch{}
      if(!list||!allowed(list.url)||new URL(list.url).hostname!==new URL(j.template).hostname||new URL(list.url).pathname!=='/mmsos/orders.html'){
        list=await chrome.tabs.create({url:j.listURL,active:false});j.listTab=list.id;j.stage='prepare';j.signature=null;await save(s);return {ok:true};
      }
      if(['prepare','preparing'].includes(j.stage)){j.stage='prepare';await save(s);return {ok:true};}
      let worker;try{if(j.worker)worker=await chrome.tabs.get(j.worker);}catch{}
      if(worker&&detailTemplate(worker.url,new URL(j.template).hostname)&&new URL(worker.url).searchParams.get('parent_order_sn')===j.pending[j.index]){j.detail=worker.id;j.stage='detail';await save(s);return {ok:true};}
      j.worker=null;j.detail=null;
      if(j.stage==='detail'||j.stage==='list'){j.stage='list';await save(s);await drive(s);}
      else {if(j.stage!=='page')j.stage='ready';await save(s);await platformPage(s,await send(j.listTab,{type:'LIST'}));}return {ok:true};
    }
    if(j.quiet){
      if(new URL(tab.url).hostname!==new URL(j.template).hostname)throw Error('当前店铺域名与后台任务不一致');
      j.base=tab.id;j.active=true;j.started=Date.now();j.message='继续后台采集';
      let worker;try{if(j.worker)worker=await chrome.tabs.get(j.worker);}catch{}
      if(worker&&detailTemplate(worker.url,new URL(j.template).hostname)&&new URL(worker.url).searchParams.get('parent_order_sn')===j.pending[j.index]){j.detail=worker.id;j.stage='detail';await save(s);}
      else{j.worker=null;j.detail=null;j.stage='list';await save(s);await drive(s);}return {ok:true};
    }
    const page=await send(tab.id,{type:'LIST'});
    if(page.orders?.length){
      j.base=tab.id;j.detail=tab.id;j.stage='list';
      if(page.orders.join('|')!==j.signature){j.pending=page.orders.filter(o=>!j.processed.includes(o));j.index=0;j.signature=page.orders.join('|');}
    }
    else{const detail=await send(tab.id,{type:'CAPTURE_PAGE'});if(detail.order!==j.order)throw Error('当前详情不是待续采订单，请返回对应列表');j.detail=tab.id;j.stage='detail';}
    if(j.index>=j.pending.length){j.active=true;j.stage='list';}
    else{j.active=true;j.started=Date.now();}
    j.message='继续采集';await save(s);if(j.stage==='list')await drive(s);return {ok:true};
  }
  if(msg.type==='LIST_READY'&&j?.active&&j.platform&&tabId===j.listTab){
    const actual=await chrome.tabs.get(tabId);if(!allowed(actual.url)||new URL(actual.url).hostname!==new URL(j.template).hostname||new URL(actual.url).pathname!=='/mmsos/orders.html')return {ok:false};
    if(j.stage==='prepare'){
      j.stage='preparing';j.started=Date.now();await save(s);const prepared=await send(j.listTab,{type:'PREPARE_LIST'});
      if(!prepared.ok){await pausePlatform(s,prepared.error||'后台列表无法确认全部订单状态');return {ok:false};}
      j.stage='ready';await save(s);await platformPage(s,await send(j.listTab,{type:'LIST'}));
    }else if(['ready','page'].includes(j.stage))await platformPage(s,msg);
    return {ok:true};
  }
  if(msg.type==='LIST_READY'&&j?.active&&tabId===j.base){
    if(j.quiet)return {ok:true};
    const signature=msg.orders.join('|');
    if(j.stage==='page'&&signature!==j.signature){
      j.pending=msg.orders.filter(o=>!j.processed.includes(o));j.index=0;j.signature=signature;j.stage='list';await save(s);await drive(s);
    }else if(j.stage==='list'&&(j.index>=j.pending.length||msg.orders.includes(j.pending[j.index])))await drive(s);
    return {ok:true};
  }
  if(msg.type==='DETAIL_RESULT'&&j?.active&&j.stage==='detail'&&tabId===j.detail&&msg.result.order===j.order){
    if(j.quiet){
      const allowedIds=j.expectedSkus?.[j.order]||[];
      const cancelled=/^(?:已取消|cancelled|canceled)$/i.test(String(msg.result.status||'').trim());
      const result={...msg.result,records:(msg.result.records||[]).filter(r=>r.order===j.order&&(j.platform||allowedIds.includes(r.sku)))};
      if(j.platform&&!result.created)result.created=result.records[0]?.orderCreated||'';
      if(cancelled)addError(s,j.order,'详情状态为已取消，跳过采集');else{
        const actualMonth=createdMonth(result.created||result.records[0]?.orderCreated);
        if(j.platform&&(!actualMonth||actualMonth!==j.month)){
          addError(s,j.order,!actualMonth?'详情缺少可靠创建时间，未计入所选月份':'详情创建月份不符，跳过');result.records=[];
        }
        for(const sku of allowedIds)if(!result.records.some(r=>r.sku===sku))addError(s,j.order,'导入SKU '+sku+' 未在详情中读取到明确申报价格');
        remember(s,result,j.month);
      }
      j.processed.push(j.order);j.index++;j.stage='list';const worker=j.worker;j.worker=null;j.detail=null;await save(s);
      if(worker===tabId&&worker!==j.base)try{await chrome.tabs.remove(worker);}catch{}
      await drive(s);return {ok:true};
    }
    remember(s,msg.result,j.month);j.processed.push(j.order);j.index++;j.stage='return';await save(s);
    if(j.detail!==j.base){await chrome.tabs.remove(j.detail);j.detail=j.base;j.stage='list';await save(s);await drive(s);}
    else{j.stage='list';await save(s);try{await chrome.tabs.goBack(j.base);}catch{j.active=false;j.message='请手动返回订单列表后点击继续';await save(s);}}
    return {ok:true};
  }
  if(msg.type==='EXPORT'){
    const selectedMonth=/^\d{4}-\d{2}$/.test(msg.month||'')?msg.month:j?.quiet?j.month:'';
    const headers=['订单号','SKU ID','SKU货号','应履约件数','申报价格','币种',...(msg.full?['订单创建时间']:[]),'采集记录','来源链接'];
    const quote=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
    const selected=Object.values(s.records).filter(r=>!selectedMonth||(r.month||r.created?.slice(0,7))===selectedMonth).filter(r=>!(j?.imported&&selectedMonth===j.month)||j.expectedSkus[r.order]?.includes(r.sku));
    const rows=selected.map(r=>[r.order,r.sku,r.ref,r.quantity,r.price,r.currency,...(msg.full?[r.created]:[]),r.captured,r.source]);
    if(!rows.length)throw Error('尚无采集记录');
    const data='\uFEFF'+[headers,...rows].map(row=>row.map(quote).join(',')).join('\r\n');
    await chrome.downloads.download({url:'data:text/csv;charset=utf-8,'+encodeURIComponent(data),filename:msg.full?'Temu采集订单明细.csv':'Temu订单申报价格.csv',saveAs:true});return {ok:true};
  }
  if(msg.type==='CLEAR'){if(j?.active)throw Error('请先暂停采集');await save({records:{},job:null,errors:[]});return {ok:true};}
  return {ok:true};
}
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  serial=serial.catch(()=>{}).then(()=>handle(msg,sender));serial.then(respond,error=>respond({error:error.message}));return true;
});
chrome.tabs.onCreated.addListener(tab=>{
  serial=serial.catch(()=>{}).then(async()=>{
    const s=await load(),j=s.job;
    if(j?.active&&!j.quiet&&j.stage==='detail'&&tab.openerTabId===j.base){j.detail=tab.id;await save(s);}
  });
});
chrome.alarms.create('watchdog',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(()=>{
  serial=serial.catch(()=>{}).then(async()=>{
    const s=await load(),j=s.job;
    if(j?.active&&['detail','page','return','prepare','preparing','ready'].includes(j.stage)&&Date.now()-j.started>90000){j.active=false;j.message='等待页面超时，已暂停；处理登录/页面问题后点击继续';addError(s,j.order,j.message);await save(s);}
  });
});
if(typeof importScripts==='function')importScripts('bridge-config.js','bridge-client.js');
