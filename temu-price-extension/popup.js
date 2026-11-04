const $=id=>document.getElementById(id);
let imported=null,updating=false,lastActionError="";
async function ask(type,extra={}){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const result=await chrome.runtime.sendMessage({type,tabId:tab?.id,...extra});
  if(result.error)throw Error(result.error);return result;
}
async function refresh(){
  if(updating)return;
  const bridge=await ask('BRIDGE_STATUS');
  $('bridge').textContent=bridge.connected?'本机桥接：已连接':bridge.configured?'本机桥接：未连接 '+(bridge.lastError||''):'本机桥接：尚未配对';
  const s=await ask('STATUS');const j=s.job;
  $('status').textContent=(lastActionError?'操作失败：'+lastActionError+'\n\n':'')+'已保存 '+s.count+' 条订单/SKU价格\n'+(j?`${j.active?'采集中':j.stage==='done'?'读取结束':'已暂停或任务结束'}：${j.message}\n本任务已处理 ${j.processed?.length||0} 个订单 / ${j.pageCount||0} 页\n排除取消 ${j.excludedCancelled||0} 单，其他月份 ${j.excludedOtherMonth||0} 单\n详情成功 ${j.successfulOrders||0} 单，读取异常 ${j.failedOrders||0} 单，需核对 ${j.warningOrders||0} 单\n${j.order||''}`:'尚无批量任务')+'\n'+s.errors.map(e=>(e.order||'')+' '+e.reason).join('\n');
}
$('connect').onclick=async()=>{await ask('BRIDGE_TOGGLE',{enabled:true});await refresh();};
$('disconnect').onclick=async()=>{await ask('BRIDGE_TOGGLE',{enabled:false});await refresh();};
$('orderFile').onchange=async()=>{
  try{
    const file=$('orderFile').files[0];if(!file)return;
    let text=await file.text();
    if(text.includes('\uFFFD'))text=new TextDecoder('gb18030').decode(await file.arrayBuffer());
    imported=OrderImport.parseCSV(text,$('month').value);
    await chrome.storage.local.set({importedOrders:imported,selectedMonth:$('month').value,importedMonth:$('month').value});
    $('importStatus').textContent=`已识别 ${imported.orders.length} 单 / ${imported.count} 个订单SKU，排除取消 ${imported.excludedCancelled} 行，其他月份 ${imported.excludedOtherMonth} 行`;
    if(imported.errors.length)$('status').textContent=imported.errors.join('\n');
  }catch(e){imported=null;$('importStatus').textContent=e.message;}
};
$('importStart').onclick=async()=>{
  try{
    const saved=await chrome.storage.local.get(['importedOrders','importedMonth']);
    imported=imported||saved.importedOrders;
    if(!imported?.orders?.length)throw Error('请先选择月份并导入订单CSV');
    if(saved.importedMonth!==$('month').value)throw Error('月份已改变，请按新月份重新导入CSV');
    await ask('START_IMPORTED',{month:$('month').value,orders:imported.orders,expectedSkus:imported.expectedSkus});await refresh();
  }catch(e){$('status').textContent=e.message;}
};
for(const [id,type] of Object.entries({retryFailed:'RETRY_FAILED',reviewExport:'EXPORT_REVIEW',capture:'CAPTURE',pause:'PAUSE',resume:'RESUME',export:'EXPORT',full:'EXPORT',clear:'CLEAR',start:'START'})){
  $(id).onclick=async()=>{
    try{
      if(id==='clear'&&!confirm('只清除本扩展的本地采集记录，是否继续？'))return;
      await ask(type,{month:$('month').value,autoNext:$('next').checked,full:id==='full'});
      if(id==='start')await chrome.storage.local.set({selectedMonth:$('month').value});
      await refresh();
    }catch(e){$('status').textContent=e.message;}
  };
}
chrome.storage.local.get(['selectedMonth','importedOrders']).then(s=>{if(s.selectedMonth)$('month').value=s.selectedMonth;if(s.importedOrders){imported=s.importedOrders;$('importStatus').textContent=`已保留 ${imported.orders.length} 个待采订单，已排除取消记录`;}});
refresh();setInterval(refresh,2000);

$('quiet').onclick=async()=>{lastActionError='';updating=true;$('status').textContent='正在建立后台任务并识别真实详情地址，请稍候…';try{await chrome.storage.local.set({selectedMonth:$('month').value});await ask('START_PLATFORM',{month:$('month').value});updating=false;await refresh();}catch(e){updating=false;lastActionError=e.message;await refresh();}};
$('update').onclick=async()=>{updating=true;try{const r=await ask('EXTENSION_UPDATE',{operation:'check'});$('status').textContent=r.message||'检查中';if(r.available&&confirm('发现插件 '+r.available+'，现在更新？采集记录保留，正在采集的任务将暂停。')){await ask('PAUSE');await ask('EXTENSION_UPDATE',{operation:'apply'});$('status').textContent='正在下载并校验更新…';const timer=setInterval(async()=>{try{const s=await ask('EXTENSION_UPDATE',{operation:'status'});$('status').textContent=s.message||s.state;if(s.state==='done'){clearInterval(timer);chrome.runtime.reload();}if(s.state==='error'){clearInterval(timer);updating=false;}}catch(e){clearInterval(timer);$('status').textContent=e.message;}},1500);}else updating=false;}catch(e){updating=false;$('status').textContent=e.message;}};
