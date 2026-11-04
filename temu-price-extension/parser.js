(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PriceParser=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const orderRE=/\bPO-\d+-\d+\b/g;
 const skuRE=/SKU\s*ID\s*[:：]?\s*(\d+)/gi;
 function unique(a){return [...new Set(a)];}
 function parseSingle(input){
  const text=String(input||'').replace(/\u00a0/g,' '),errors=[],records=[];
  const orders=unique(text.match(orderRE)||[]),order=orders.length===1?orders[0]:null;
  if(!order)errors.push(orders.length?'页面包含多个订单号，无法确定详情订单':'未找到订单号');
  if(/验证码|人机验证|captcha|请登录|扫码登录/i.test(text)){errors.push('页面可能需要登录或完成验证');return {order,records,errors};}
  const markers=[...text.matchAll(skuRE)];
  if(!markers.length)errors.push('未找到 SKU ID 商品详情');
  for(let i=0;i<markers.length;i++){
   const marker=markers[i],sku=marker[1],section=text.slice(marker.index,i+1<markers.length?markers[i+1].index:text.length);
   const prices=[];const currencies=[];
   // Temu's detail label 申报价格 is a unit price (confirmed by the user).
   // Total declarations must never be interpreted as that label.
   const priceRE=/(?<![\p{L}\p{N}])(?:单件)?申报价(?:格)?\s*(?:[（(]\s*([A-Z]{3})\s*[）)])?\s*[:：]?\s*(?:([A-Z]{3})\s*)?[$￥¥€£]?\s*([\d,]+(?:\.\d+)?)\b/giu;
   for(const m of section.matchAll(priceRE)){prices.push(m[3].replace(/,/g,''));currencies.push((m[1]||m[2]||'USD').toUpperCase());}
   const values=unique(prices.map(p=>String(Number(p)))),cc=unique(currencies);
   if(values.length!==1||cc.length!==1){errors.push('SKU '+sku+(values.length?' 单件申报价格存在歧义':' 缺少明确单件申报价格'));continue;}
   const price=Number(values[0]);if(!Number.isFinite(price)||price<0){errors.push('SKU '+sku+' 价格无效');continue;}
   const refMatch=section.match(/SKU\s*货号\s*[:：]?\s*(\d{6}[^\s\n]*)/i);
   const qtyMatches=[...section.matchAll(/(?:(?:^|\s)[×xX]\s*(\d+)\b|(?:件数|数量)\s*[:：]?\s*(\d+)\b)/g)].map(m=>Number(m[1]||m[2]));
   const quantities=unique(qtyMatches.filter(q=>q>0&&Number.isSafeInteger(q)));
   if(quantities.length>1){errors.push('SKU '+sku+' 数量存在歧义');continue;}
   if(!quantities.length)errors.push('SKU '+sku+' 缺少明确件数，保留价格待核对');
   if(order)records.push({order,sku,ref:refMatch?refMatch[1]:'',quantity:quantities.length===1?quantities[0]:null,price,currency:cc[0]});
  }
  const created=text.match(/(?:订单创建时间|创建时间)\s*[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/);
  if(created)for(const r of records)r.orderCreated=created[1];
  const grouped=new Map();
  for(const record of records){const k=record.order+'|'+record.sku;const previous=grouped.get(k);if(previous&&JSON.stringify(previous)!==JSON.stringify(record)){grouped.set(k,null);errors.push('同订单SKU '+record.sku+' 出现冲突记录');}else if(!grouped.has(k))grouped.set(k,record);}
  return {order,records:[...grouped.values()].filter(Boolean),errors};
 }
 function combineChildren(order,entries,errors){
  const children=new Map();
  for(const entry of entries){
   const old=children.get(entry.child);
   if(old?.cancelled)continue;
   if(entry.cancelled){children.set(entry.child,entry);continue;}
   if(old?.conflict)continue;
   if(!old){children.set(entry.child,entry);continue;}
   const merged=new Map(old.records.map(r=>[r.sku,{...r}]));let conflict=false;
   for(const record of entry.records){
    const previous=merged.get(record.sku);
    if(!previous){merged.set(record.sku,{...record});continue;}
    const different=previous.price!==record.price||previous.currency!==record.currency||
     (previous.ref&&record.ref&&previous.ref.slice(0,6)!==record.ref.slice(0,6))||
     (previous.quantity!==null&&record.quantity!==null&&previous.quantity!==record.quantity);
    if(different){conflict=true;break;}
    if(previous.quantity===null&&record.quantity!==null)previous.quantity=record.quantity;
    if(!previous.ref&&record.ref)previous.ref=record.ref;
   }
   if(conflict){errors.push('子订单 '+entry.child+' 重复展示的明确价格或件数冲突，未计入');children.set(entry.child,{cancelled:false,records:[],conflict:true});}
   else children.set(entry.child,{...old,records:[...merged.values()]});
  }
  const grouped=new Map(),blocked=new Set();
  for(const entry of children.values()){
   if(entry.cancelled)continue;
   for(const r of entry.records){
    if(blocked.has(r.sku))continue;
    const old=grouped.get(r.sku);
    if(!old){grouped.set(r.sku,{...r});continue;}
    if(old.price!==r.price||old.currency!==r.currency||old.ref.slice(0,6)!==r.ref.slice(0,6)){
     errors.push('有效子订单的 SKU '+r.sku+' 价格、币种或货号不同，需逐子订单核对；未合并');grouped.delete(r.sku);blocked.add(r.sku);continue;
    }
    old.quantity=old.quantity===null||r.quantity===null?null:old.quantity+r.quantity;
   }
  }
  const records=[...grouped.values()];
  errors=errors.filter(e=>!records.some(r=>r.quantity!==null&&e==='SKU '+r.sku+' 缺少明确件数，保留价格待核对'));
  return {order,records,errors};
 }
 function parseText(input){
  const text=String(input||''),base=parseSingle(text);
  const markers=[...text.matchAll(/子订单号\s*[:：]?\s*([\d-]+)/g)];
  if(!base.order||!markers.length)return base;
  const entries=[],errors=[];
  for(let i=0;i<markers.length;i++){
   const m=markers[i],chunk=text.slice(m.index,i+1<markers.length?markers[i+1].index:text.length);
   if(/已取消|\bcancel(?:led|ed)\b/i.test(chunk)){entries.push({child:m[1],cancelled:true,records:[]});continue;}
   const sku=[...chunk.matchAll(skuRE)][0];
   const arranged=sku?chunk.slice(sku.index)+'\n'+chunk.slice(0,sku.index):chunk;
   const parsed=parseSingle(base.order+'\n'+arranged);errors.push(...parsed.errors);
   entries.push({child:m[1],cancelled:false,records:parsed.records});
  }
  const result=combineChildren(base.order,entries,errors);
  const created=text.match(/(?:订单创建时间|创建时间)\s*[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/);
  if(created)for(const r of result.records)r.orderCreated=created[1];
  return result;
 }
 function parseDocument(doc){
  const body=doc.body,bodyText=body?(body.innerText||body.textContent||''):'';
  const result=parseText(bodyText);if(!result.order||!body)return result;
  const candidates=[],seenCards=new Set();
  for(const element of body.querySelectorAll('*')){
   if(element.children.length||!/SKU\s*ID/i.test(element.innerText||element.textContent||''))continue;
   let card=element,fallback=null,selected=null;
   for(let depth=0;card&&depth<10;depth++,card=card.parentElement){
    const text=card.innerText||card.textContent||'',ids=[...text.matchAll(skuRE)];
    if(ids.length>1)break;
    if(ids.length===1&&/(?<![\p{L}\p{N}])(?:单件)?申报价/iu.test(text)){
     if(!fallback)fallback=card;
     if(/子订单号\s*[:：]?\s*[\d-]+/.test(text)){selected=card;break;}
    }
   }
   card=selected||fallback;if(!card||seenCards.has(card))continue;seenCards.add(card);
   const text=card.innerText||card.textContent||'',id=[...text.matchAll(skuRE)][0];
   const child=text.match(/子订单号\s*[:：]?\s*([\d-]+)/)?.[1];
   const stamps=typeof card.querySelectorAll==='function'?[...card.querySelectorAll('[alt],[title],[aria-label]')].map(el=>[el.getAttribute('alt'),el.getAttribute('title'),el.getAttribute('aria-label')].join(' ')).join(' '):'';
   const cancelled=/已取消|\bcancel(?:led|ed)\b/i.test(text+' '+stamps);
   // Product quantity is rendered in the title before SKU ID. Once present,
   // do not mix it with quantities from logistics/history elsewhere in the card.
   const titleQuantities=unique([...text.slice(0,id.index).matchAll(/[×xX]\s*(\d+)\b/g)].map(m=>Number(m[1])).filter(n=>Number.isSafeInteger(n)&&n>0));
   let arranged=text.slice(id.index)+'\n'+text.slice(0,id.index);
   if(titleQuantities.length===1)arranged=arranged.replace(/(?:[×xX]\s*\d+\b|(?:件数|数量)\s*[:：]?\s*\d+\b)/g,'')+'\n数量：'+titleQuantities[0];
   const parsed=cancelled?{records:[],errors:[]}:parseSingle(result.order+'\n'+arranged);
   candidates.push({child:child||'sku:'+id[1],cancelled,records:parsed.records,errors:parsed.errors,hasChild:!!child});
  }
  if(candidates.length){
   const declared=[...bodyText.matchAll(/子订单号\s*[:：]?\s*([\d-]+)/g)].map(m=>m[1]);
   const covered=new Set(candidates.filter(c=>c.hasChild).map(c=>c.child));
   if(!declared.length||declared.every(id=>covered.has(id))){
    const merged=combineChildren(result.order,candidates,candidates.flatMap(c=>c.errors));
    result.records=merged.records;result.errors=merged.errors;
   }
  }
  const created=bodyText.match(/(?:订单创建时间|创建时间)\s*[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/);
  if(created)for(const r of result.records)r.orderCreated=created[1];
  return result;
 }
 return {parseText,parseDocument};
});
