/* Read-only order navigation: never call shipment, confirmation or payment controls. */
(() => {
  if(globalThis.__temuPriceContentLoaded)return;
  globalThis.__temuPriceContentLoaded=true;
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const text = () => document.body?.innerText || '';
  function detailTargets(includeCancelled=false) {
    const results = new Map();
    for (const el of document.querySelectorAll('a,button,span,div')) {
      if (el.children.length || !visible(el) || el.textContent.trim() !== '订单详情') continue;
      let parent=el;
      for(let n=0; parent && n<10; n++,parent=parent.parentElement) {
        const orders=[...new Set((parent.innerText||'').match(/\bPO-\d+-\d+\b/g)||[])];
        if(orders.length>1)break;
        if(orders.length===1){
          const row=parent.closest('tr,[role="row"]')||parent;
          const cells=[...row.querySelectorAll('td,[role="cell"]')];
          if((includeCancelled||!cells.some(cell=>(cell.innerText||'').replace(/\s+/g,'')==='已取消'))&&!results.has(orders[0]))results.set(orders[0],el);
          break;
        }
      }
    }
    return results;
  }
  function listData(){
    const items=[];
    for(const [order,el] of detailTargets(true)){
      const row=el.closest('tr,[role="row"]')||el.parentElement;
      const value=row?.innerText||'';
      const cells=[...(row?.querySelectorAll('td,[role="cell"]')||[])];
      const status=cells.some(c=>(c.innerText||'').replace(/\s+/g,'')==='已取消')?'已取消':'';
      const created=value.match(/订单创建时间\s*[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
      items.push({order,status,created:created?created[1].replaceAll('/','-'):''});
    }
    return {items,orders:items.filter(r=>r.status!=='已取消').map(r=>r.order),url:location.href};
  }
  async function prepareList(){
    if(location.pathname!=='/mmsos/orders.html')throw Error('当前不是已识别的订单列表页');
    const buttons=()=>[...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const candidates=[...document.querySelectorAll('a,span,div,button')].filter(el=>visible(el)&&/^全部\s*[（(]\s*\d+\s*[）)]$/.test(el.innerText?.trim()||''));
    const specific=candidates.filter(el=>!candidates.some(other=>other!==el&&el.contains(other)));
    if(specific.length!==1)throw Error('无法唯一识别“全部”订单标签，已暂停');
    if(new URL(location.href).searchParams.get('queryType')!=='0'){specific[0].click();await new Promise(resolve=>setTimeout(resolve,800));}
    // Use only the page-size selector associated with the visible “每页” label.
    const pageControls=[...document.querySelectorAll('select,[role="combobox"],input')].filter(el=>{
      if(!visible(el))return false;
      let parent=el;for(let n=0;parent&&n<4;n++,parent=parent.parentElement){const t=parent.innerText||'';if(t.length<160&&/每页/.test(t)&&/条/.test(t))return true;}return false;
    });
    if(pageControls.length===1){
      const control=pageControls[0];
      if(control.tagName==='SELECT'&&[...control.options].some(o=>o.value==='500')){control.value='500';control.dispatchEvent(new Event('change',{bubbles:true}));}
      else if(String(control.value||control.textContent||'').trim()!=='500'){
        control.click();await new Promise(resolve=>setTimeout(resolve,200));
        const options=[...document.querySelectorAll('[role="option"],[class*="select-option"],[class*="SelectOption"]')].filter(el=>visible(el)&&el.textContent.trim()==='500');
        if(options.length===1)options[0].click();
      }
      await new Promise(resolve=>setTimeout(resolve,800));
    }
    // Never reset/query here: reset removed the requested month and page size.
    return {ok:true,mode:'保留目标月份及每页条数，扫描全部状态并排除已取消'};
  }

  function capture(){
    const parsed=PriceParser.parseDocument(document);
    const created=text().match(/订单创建时间\s*[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/);
    const status=text().match(/(?:^|\n)\s*状态\s*[:：]\s*([^\n]+)/);
    return {...parsed,status:status?status[1].trim():'',created:created?created[1].replaceAll('/','-'):'',url:location.href};
  }
  function nextButton(){
    const candidates=[...document.querySelectorAll('button,a,li,[role="button"]')].filter(el=>{
      if(!visible(el))return false;
      const label=(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'').trim();
      return /^(下一页|下页|Next page|Next|›|❯|→|>)$/i.test(label)||/(?:pagination|pager).*next|next.*(?:pagination|pager)/i.test(String(el.className||''));
    });
    const outer=candidates.filter(el=>!candidates.some(other=>other!==el&&other.contains(el)));
    if(outer.length!==1){
      const total=text().match(/(?:共有|共)\s*([\d,]+)\s*条/);
      const count=listData().items.length;
      if(total&&count>=Number(total[1].replaceAll(',','')))return {el:null,finished:true};
      const roots=[...document.querySelectorAll('[class*="pagination"],[class*="Pagination"],[class*="pager"],[role="navigation"]')].filter(visible);
      for(const root of roots){
        const controls=[...root.querySelectorAll('button,a,li,[role="button"]')].filter(visible);
        const current=controls.filter(el=>el.getAttribute('aria-current')==='page'||/(?:^|[-_\s])(?:active|selected|current)(?:$|[-_\s])/i.test(String(el.className||'')));
        if(current.length!==1||!/^\d+$/.test(current[0].textContent.trim()))continue;
        const next=controls.filter(el=>el.textContent.trim()===String(Number(current[0].textContent.trim())+1));
        if(next.length===1)return {el:next[0],finished:false};
      }
      return {el:null,finished:false};
    }
    const el=outer[0],disabled=el.disabled||el.getAttribute('aria-disabled')==='true'||/disabled/i.test(String(el.className||'')+' '+String(el.parentElement?.className||''));
    return {el:disabled?null:el,finished:!!disabled};
  }
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message.type==='PREPARE_LIST'){prepareList().then(reply,error=>reply({error:error.message}));return true;}
    try{
      if(message.type==='LIST')reply(listData());
      else if(message.type==='DIAGNOSTIC')reply({url:location.href,title:document.title,ready:document.readyState,orderCount:detailTargets().size,detail:capture(),inputs:[...document.querySelectorAll('input')].filter(visible).map(el=>({type:el.type,placeholder:el.placeholder,label:el.getAttribute('aria-label')||'',name:el.name})),buttons:[...document.querySelectorAll('button,[role="button"]')].filter(visible).map(el=>el.innerText?.trim()).filter(Boolean).slice(0,60)});
      else if(message.type==='CAPTURE_PAGE')reply(capture());
      else if(message.type==='OPEN_ORDER'){
        const el=detailTargets().get(message.order);
        if(!el){reply({error:'当前列表未找到该订单的详情入口'});return;}
        reply({ok:true});el.click();
      }else if(message.type==='NEXT_PAGE'){
        const next=nextButton();if(!next.el){reply({ok:false,finished:next.finished});return;}
        reply({ok:true});next.el.click();
      }
    }catch(error){reply({error:String(error.message||error)});}
  });
  let checking=false;
  async function heartbeat(){
    if(checking)return;checking=true;
    try{
      const status=await chrome.runtime.sendMessage({type:'PAGE_STATUS'});
      if(!status?.active||!status.accept)return;
      const body=text();
      if(/人机验证|请完成验证|扫码登录/.test(body)){
        await chrome.runtime.sendMessage({type:'PAUSE',reason:'页面要求登录或人工验证，请处理后点击继续'});return;
      }
      if(status.stage==='detail'){
        const result=capture();
        if(result.order===status.order && (result.records.length || /申报价格|申报价/.test(body)))
          await chrome.runtime.sendMessage({type:'DETAIL_RESULT',result});
      }else if(['prepare','list','page'].includes(status.stage)){
        const list=listData();
        if(list.items.length)await chrome.runtime.sendMessage({type:'LIST_READY',orders:list.orders,items:list.items});
      }
    }catch{}finally{checking=false;}
  }
  setInterval(heartbeat,1500);heartbeat();
})();
