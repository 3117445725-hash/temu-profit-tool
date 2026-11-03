(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.OrderImport=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function csvRows(input){
  const text=String(input||'').replace(/^\uFEFF/,''),rows=[];let row=[],field='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
   const c=text[i];
   if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
   if(c==='"'){if(field.length||closed)throw Error('CSV引号格式错误');quoted=true;continue;}
   if(c===','){row.push(field);field='';closed=false;continue;}
   if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);rows.push(row);row=[];field='';closed=false;continue;}
   if(closed){if(c===' '||c==='\t')continue;throw Error('CSV结束引号后包含无效字符');}
   field+=c;
  }
  if(quoted)throw Error('CSV引号未闭合');
  if(field.length||row.length||closed){row.push(field);rows.push(row);}
  return rows;
 }
 function dateMonth(value){
  const match=String(value||'').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if(!match)return null;
  const [y,m,d,h,min,sec]=match.slice(1).map(x=>x===undefined?0:Number(x));
  const leap=y%4===0&&(y%100!==0||y%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(y<1||m<1||m>12||d<1||d>days[m-1]||h>23||min>59||sec>59)return null;
  return String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0');
 }
 function parseCSV(text,month){
  const result={orders:[],expectedSkus:{},count:0,excludedCancelled:0,excludedOtherMonth:0,errors:[],rows:[]};
  const fail=message=>{result.errors.push(message);return result;};
  if(typeof month!=='string'||!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month))return fail('请选择有效月份 YYYY-MM');
  let rows;try{rows=csvRows(text);}catch(e){return fail(e.message);}
  if(!rows.length)return fail('订单CSV为空');
  const headers=rows[0].map(v=>v.trim());
  const aliases={order:['订单号','PO单号','订单编号'],sku:['SKU ID','SKU_ID'],date:['订单创建时间','订单创建日期'],orderStatus:['订单状态'],subStatus:['子订单状态']};
  const indexes={};
  for(const [name,names]of Object.entries(aliases)){
   const hits=headers.map((h,i)=>names.includes(h)?i:-1).filter(i=>i>=0);
   if(hits.length>1)return fail('存在多个重复或冲突表头：'+names.join('/'));
   indexes[name]=hits.length?hits[0]:-1;
  }
  if(indexes.order<0||indexes.sku<0)return fail('订单表须包含订单号和 SKU ID');
  if(indexes.date<0)return fail('缺少订单创建时间，无法安全按月筛选');
  if(indexes.orderStatus<0&&indexes.subStatus<0)return fail('缺少订单状态或子订单状态，无法排除取消订单');
  const seen=new Set(),orders=new Set();
  const cancelled=v=>/^(?:已取消|cancelled|canceled)$/i.test(v.trim());
  for(let i=1;i<rows.length;i++){
   const row=rows[i];if(row.every(v=>!v.trim()))continue;
   if(row.length!==headers.length){result.errors.push('第'+(i+1)+'行列数与表头不一致');continue;}
   const get=name=>indexes[name]<0?'':row[indexes[name]].trim();
   if(cancelled(get('orderStatus'))||cancelled(get('subStatus'))){result.excludedCancelled++;continue;}
   const actual=dateMonth(get('date'));
   if(!actual){result.errors.push('第'+(i+1)+'行订单创建时间无效');continue;}
   if(actual!==month){result.excludedOtherMonth++;continue;}
   const order=get('order'),sku=get('sku');
   if(!/^PO-\d+-\d+$/.test(order)||!/^\d+$/.test(sku)){result.errors.push('第'+(i+1)+'行订单号或SKU ID无效');continue;}
   const pair=order+'|'+sku;if(seen.has(pair))continue;seen.add(pair);
   orders.add(order);if(!result.expectedSkus[order])result.expectedSkus[order]=[];result.expectedSkus[order].push(sku);
   result.rows.push({order,sku,orderCreated:get('date'),orderStatus:get('orderStatus'),subOrderStatus:get('subStatus'),sourceRow:i+1});
  }
  result.orders=[...orders];result.count=seen.size;return result;
 }
 return {parseCSV};
});
