/* Authenticated loopback control. Only fixed read-only order actions are exposed. */
(() => {
  const cfg=globalThis.TEMU_LOCAL_BRIDGE;
  let busy=false,connected=false,lastError='',lastConnected=0;
  globalThis.TemuBridgeStatus=()=>({configured:!!cfg?.token,connected,lastError,lastConnected});
  async function post(path,data){
    const response=await fetch(cfg.url+path,{method:'POST',headers:{'Authorization':'Bearer '+cfg.token,'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(path==='/extension-update'?60000:8000)});
    if(!response.ok)throw Error('本机桥接响应 '+response.status);
    return response.json();
  }
  globalThis.TemuExtensionUpdate=operation=>post('/extension-update',{operation,currentVersion:chrome.runtime.getManifest().version});
  async function chooseTab(args){
    if(args.tabId){const tab=await chrome.tabs.get(args.tabId);if(!allowed(tab.url))throw Error('指定标签不属于授权Temu域名');return tab;}
    const tabs=(await chrome.tabs.query({active:true,lastFocusedWindow:true})).filter(t=>allowed(t.url));
    if(tabs.length===1)return tabs[0];
    const all=(await chrome.tabs.query({})).filter(t=>allowed(t.url));
    if(all.length===1)return all[0];
    throw Error('请激活要采集的Temu标签，或指定已识别的tabId');
  }
  async function execute(command){
    const args=command.args||{};
    if(['pause','resume','export'].includes(command.action)){
      const tab=command.action==='resume'?await chooseTab(args):null;
      return handle({type:{pause:'PAUSE',resume:'RESUME',export:'EXPORT'}[command.action],tabId:tab?.id},{});
    }
    const tab=await chooseTab(args);
    switch(command.action){
      case 'diagnostic':return send(tab.id,{type:'DIAGNOSTIC'});
      case 'list':return send(tab.id,{type:'LIST'});
      case 'capture':return handle({type:'CAPTURE',tabId:tab.id},{});
      case 'open_order':return send(tab.id,{type:'OPEN_ORDER',order:args.order});
      case 'next_page':return send(tab.id,{type:'NEXT_PAGE'});
      case 'back':await chrome.tabs.goBack(tab.id);return {ok:true};
      case 'start':return handle({type:'START',tabId:tab.id,month:args.month,autoNext:args.autoNext},{});
      case 'start_platform':return handle({type:'START_PLATFORM',tabId:tab.id,month:args.month},{});
      case 'start_imported':return handle({type:'START_IMPORTED',tabId:tab.id,month:args.month,orders:args.orders,expectedSkus:args.expectedSkus},{});
      default:throw Error('不支持的桥接动作');
    }
  }
  async function tick(){
    if(busy||!cfg?.token)return;
    busy=true;
    try{
      const settings=await chrome.storage.local.get({bridgeEnabled:true,bridgeInstanceId:null});
      if(!settings.bridgeEnabled){connected=false;return;}
      let browserId=settings.bridgeInstanceId;
      if(!browserId){browserId=crypto.randomUUID();await chrome.storage.local.set({bridgeInstanceId:browserId});}
      const tabs=(await chrome.tabs.query({})).filter(t=>allowed(t.url)).slice(0,100).map(t=>({id:t.id,title:(t.title||'').slice(0,180),url:t.url}));
      const packet=await post('/poll',{browserId,browserName:navigator.userAgent.includes('Edg/')?'Edge':'Chromium',tabs});
      connected=true;lastError='';lastConnected=Date.now();
      for(const command of packet.commands||[]){
        let result,ok=true;
        try{if(Date.now()>command.expiresAt)throw Error('命令已过期');result=await (serial=serial.catch(()=>{}).then(()=>execute(command)));if(result?.error)throw Error(result.error);}
        catch(error){ok=false;result={error:error.message};}
        await post('/result',{id:command.id,browserId,ok,result});
      }
    }catch(error){connected=false;lastError=error.message;}
    finally{busy=false;}
  }
  setInterval(tick,2000);
  chrome.alarms.create('bridge-poll',{periodInMinutes:0.5});
  chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='bridge-poll')tick();});
  tick();
})();
