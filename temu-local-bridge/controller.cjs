'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const config=JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA||process.env.HOME,'ProfitTool','bridge','config.json'),'utf8'));
const args=process.argv.slice(2),action=args[0]||'status';
function option(name){const i=args.indexOf(name);return i<0?undefined:args[i+1];}
const headers={Authorization:'Bearer '+config.token,'Content-Type':'application/json'},base='http://127.0.0.1:18746';
async function request(route,data){const response=await fetch(base+route,{headers,method:data?'POST':'GET',...(data?{body:JSON.stringify(data)}:{})});const result=await response.json();if(!response.ok)throw Error(result.error);return result;}
(async()=>{
 if(action==='status'){console.log(JSON.stringify(await request('/status'),null,2));return;}
 const browserId=option('--browser');if(!browserId)throw Error('需要 --browser 实例标识，先运行 status');
 const payload={};if(option('--tab'))payload.tabId=Number(option('--tab'));
 if(action==='open_order')payload.order=option('--order');
 if(action==='start'){payload.month=option('--month');payload.autoNext=args.includes('--auto-next');}
 if(action==='start_imported'){
  const file=option('--csv');if(!file)throw Error('需要 --csv 对应店铺的订单明细路径');
  const importer=require('../temu-price-extension/order-import.js');
  let text=fs.readFileSync(file,'utf8');if(text.includes('\uFFFD'))text=new TextDecoder('gb18030').decode(fs.readFileSync(file));
  const imported=importer.parseCSV(text,option('--month'));
  if(imported.errors.length)throw Error('订单导入存在需核对的问题：'+imported.errors.slice(0,5).join('；'));
  payload.month=option('--month');payload.orders=imported.orders;payload.expectedSkus=imported.expectedSkus;
  console.log(JSON.stringify({eligibleOrders:imported.orders.length,eligibleOrderSkus:imported.count,excludedCancelled:imported.excludedCancelled,excludedOtherMonth:imported.excludedOtherMonth}));
 }
 const command=await request('/command',{browserId,action,args:payload,requestId:crypto.randomUUID()});
 for(let i=0;i<115;i++){
  const result=await request('/result?id='+command.id);
  if(result.status==='completed'||result.status==='timeout'){console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;return;}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 throw Error('命令尚未完成，请检查扩展连接，不自动重复动作');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
