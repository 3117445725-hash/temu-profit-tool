(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PriceParser=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const orderRE=/\bPO-\d+-\d+\b/g;
 const skuRE=/SKU\s*ID\s*[:：]?\s*(\d+)/gi;
 function unique(a){return [...new Set(a)];}
 function parseText(input){
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
   if(order)records.push({order,sku,ref:refMatch?refMatch[1]:'',quantity:quantities.length===1?quantities[0]:null,price,currency:cc[0]});
  }
  const created=text.match(/(?:订单创建时间|创建时间)\s*[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/);
  if(created)for(const r of records)r.orderCreated=created[1];
  const grouped=new Map();
  for(const record of records){const k=record.order+'|'+record.sku;const previous=grouped.get(k);if(previous&&JSON.stringify(previous)!==JSON.stringify(record)){grouped.set(k,null);errors.push('同订单SKU '+record.sku+' 出现冲突记录');}else if(!grouped.has(k))grouped.set(k,record);}
  return {order,records:[...grouped.values()].filter(Boolean),errors};
 }
 function parseDocument(doc){
  const body=doc.body;const result=parseText(body?(body.innerText||body.textContent||''):'');
  // A SKU card may render its unit price before its identifier. Only use a DOM
  // ancestor containing exactly one SKU marker and an explicit price label.
  if(!result.order||!body)return result;
  const candidates=[];
  for(const element of body.querySelectorAll('*')){
   if(element.children.length)continue;
   if(!/SKU\s*ID/i.test(element.innerText||element.textContent||''))continue;
   let card=element;
   for(let depth=0;card&&depth<7;depth++,card=card.parentElement){
    const text=card.innerText||card.textContent||'';const ids=[...text.matchAll(skuRE)];
    if(ids.length>1)break;
    if(ids.length===1&&/(?<![\p{L}\p{N}])(?:单件)?申报价/iu.test(text)){
     const id=ids[0];const rearranged=text.slice(id.index)+ '\n'+text.slice(0,id.index);
     const parsed=parseText(result.order+'\n'+rearranged);
     candidates.push(...parsed.records);break;
    }
   }
  }
  if(candidates.length){
   const joined=new Map(result.records.map(r=>[r.sku,r]));
   for(const r of candidates){const old=joined.get(r.sku);if(old&&(old.price!==r.price||old.currency!==r.currency||(old.quantity!==null&&r.quantity!==null&&old.quantity!==r.quantity))){joined.set(r.sku,null);result.errors.push('SKU '+r.sku+' 商品卡片数据冲突');}else if(!joined.has(r.sku)||old!==null)joined.set(r.sku,r);}
   result.records=[...joined.values()].filter(Boolean);
   result.errors=result.errors.filter(e=>!result.records.some(r=>e==='SKU '+r.sku+' 缺少明确单件申报价格'));
  }
  const created=(body.innerText||body.textContent||'').match(/(?:订单创建时间|创建时间)\s*[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/);
  if(created)for(const r of result.records)r.orderCreated=created[1];
  return result;
 }
 return {parseText,parseDocument};
});
