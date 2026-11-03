"""Discover spreadsheet roles by fields; normalize locally for the calculation engine."""
import csv,tempfile,re,zipfile
from functools import lru_cache
from xml.etree import ElementTree as ET
from posixpath import dirname,join,normpath
from openpyxl.utils.cell import range_boundaries
from openpyxl.cell import WriteOnlyCell
from pathlib import Path
import openpyxl
import core

ALIASES={'订单号':['订单号','PO单号','订单编号'],'SKU ID':['SKU ID','SKU_ID','skuId'],'SKU货号':['SKU货号','货号','SKU（TEMU)','SKU（TEMU）','SKU(TEMU)','SKU'],'SKC货号':['SKC货号'],'应履约件数':['应履约件数','件数','数量','销售件数'],'申报价格':['申报价格','申报价'],'币种':['币种','货币'],'交易类型':['交易类型']}
COSTS=['FOB采购价','头程费用','尾程运费','处理费','美仓仓储费率','资金成本率']
def clean(v):return core.key(v).replace('\n','').strip()
def canonical(v):
 s=clean(v)
 for name,aliases in ALIASES.items():
  if s in aliases:return name
 return s

def workbook_merges(path):
 """Read only merge metadata from compressed XML; never materialize workbook cells."""
 ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
 with zipfile.ZipFile(path) as archive:
  rels=ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
  targets={r.attrib['Id']:normpath(join('xl',r.attrib['Target'])).lstrip('/') if not r.attrib['Target'].startswith('/') else r.attrib['Target'].lstrip('/') for r in rels}
  book=ET.fromstring(archive.read('xl/workbook.xml'));result={}
  for sheet in book.find('s:sheets',ns):
   rid=sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'];target=targets[rid];ranges=[];tail=b''
   with archive.open(target) as stream:
    while True:
     chunk=stream.read(1024*1024)
     if not chunk:break
     block=tail+chunk
     ranges.extend(range_boundaries(m.decode('ascii')) for m in re.findall(rb'<(?:[A-Za-z0-9_]+:)?mergeCell\s+ref="([A-Z]+[0-9]+:[A-Z]+[0-9]+)"',block))
     tail=block[-100:]
   result[sheet.attrib['name']]=list(dict.fromkeys(ranges))
  return result

def tables(paths):
 for raw in dict.fromkeys(str(p) for p in paths if p):
  path=Path(raw)
  if path.suffix.lower()=='.csv':
   for enc in ['utf-8-sig','gb18030']:
    try:
     with path.open(encoding=enc,newline='') as f:data=list(csv.reader(f))
     break
    except UnicodeError:pass
   else:raise ValueError('CSV编码无法识别: '+path.name)
   yield str(path),'CSV',data
  elif path.suffix.lower()=='.xlsx':
   w=openpyxl.load_workbook(path,read_only=True,data_only=True)
   try:
    merges=workbook_merges(path)
    for sheet in w:
     starts={}
     for min_col,min_row,max_col,max_row in merges.get(sheet.title,[]):
      if max_row-min_row>10000:continue
      starts.setdefault(min_row,[]).append((min_col,max_col,max_row))
     active=[];data=[]
     for ri,values in enumerate(sheet.iter_rows(values_only=True),1):
      row=list(values)
      for lo,hi,end in starts.get(ri,[]):
       value=row[lo-1] if len(row)>=lo else None
       active.append((lo,hi,end,value))
      for lo,hi,end,value in active:
       if len(row)<hi:row.extend([None]*(hi-len(row)))
       row[lo-1:hi]=[value]*(hi-lo+1)
      active=[area for area in active if area[2]>ri]
      data.append(row)
     yield str(path),sheet.title,data
   finally:w.close()
  else:raise ValueError('不支持的文件: '+path.name)

def _discover(paths):
 found=[]
 for path,sheet,data in tables(paths):
  candidates=[]
  for start in range(min(10,len(data))):
   for count in (1,2):
    if start+count>len(data):continue
    columns={}
    for head in data[start:start+count]:
     for col,v in enumerate(head):
      name=canonical(v)
      if name and (name in ALIASES or name in COSTS or '时间' in name or '日期' in name):columns[name]=col
    score=len(columns)
    if 'SKU ID' in columns:score+=5
    if '订单号' in columns:score+=3
    if set(COSTS).issubset(columns):score+=15
    # Prefer a single header when adding a data row discovers no new fields.
    candidates.append((score,-count,-start,columns,start+count))
  if not candidates:continue
  _,_,_,cols,offset=max(candidates,key=lambda x:x[:3])
  if not ('SKU ID' in cols or set(COSTS).intersection(cols)):continue
  records=[dict({name:r[col] if col<len(r) else None for name,col in cols.items()},__source_row__=rownum) for rownum,r in enumerate(data[offset:],offset+1) if any(v is not None and clean(v) for v in r)]
  dates=[k for k in cols if '时间' in k or '日期' in k]
  roles=[]
  if {'订单号','SKU ID'}.issubset(cols) and dates:roles.append('订单')
  if 'SKU ID' in cols and ('SKU货号' in cols or 'SKC货号' in cols):roles.append('货号映射')
  if {'订单号','SKU ID','申报价格'}.issubset(cols):roles.append('价格/结算')
  if 'SKU货号' in cols and set(COSTS).intersection(cols):roles.append('成本')
  found.append({'path':path,'sheet':sheet,'header_row':offset,'fields':list(cols),'roles':roles,'records':records,'dates':dates})
 return found

@lru_cache(maxsize=2)
def _cached_discover(signature):
 return _discover([entry[0] for entry in signature])

def discover(paths):
 signature=tuple((str(Path(p).resolve()),Path(p).stat().st_size,Path(p).stat().st_mtime_ns) for p in dict.fromkeys(paths) if p)
 return _cached_discover(signature)

def inspect_files(paths,_data=None):
 data=discover(paths) if _data is None else _data;orders=[t for t in data if '订单' in t['roles']]
 if not orders:raise ValueError('所有表中均未识别到同时含订单号、SKU ID和日期的订单数据')
 # Multiple order datasets can overlap; do not guess silently which shop/range is authoritative.
 if len(orders)>1:raise ValueError('识别到多个订单数据表，请保留一个订单数据来源：'+'、'.join(Path(t['path']).name+'/'+t['sheet'] for t in orders))
 t=orders[0];months={}
 for field in t['dates']:
  values=set()
  for r in t['records']:
   try:values.add(core.month(r.get(field)))
   except ValueError:pass
  months[field]=sorted(values)
 return {'fields':t['dates'],'months':months,'tables':[{k:v for k,v in x.items() if k not in ('records','dates')} for x in data],'order_source':t['path']+' / '+t['sheet']}

def write_book(path,rows,title='Sheet1'):
 w=openpyxl.Workbook(write_only=True);sheet=w.create_sheet(title)
 for row in rows:
  values=[]
  for value in row:
   if isinstance(value,str):
    cell=WriteOnlyCell(sheet,value=value);cell.data_type='s';values.append(cell)
   else:values.append(value)
  sheet.append(values)
 w.save(path)

def scan_auto(paths):
 report=inspect_files(paths)
 return report['fields'],report['months']

def calculate_auto(paths,month,date_field='订单创建时间',freight='0',currency='USD',refund='10',progress=None):
 notify=progress or (lambda text:None)
 notify('读取并识别文件；大成本表首次加载较慢，未修改文件会复用缓存')
 data=discover(paths);report=inspect_files(paths,data);order=next(t for t in data if '订单' in t['roles'])
 notify('文件读取完成，正在建立订单和相关SKU的成本索引')
 products=set();product_sources=[];settlements={'未结算':[],'已结算':[]};pairs=set();cost_rows=[];cost_groups={};source_map=[]
 selected_ids={core.key(r.get('SKU ID')) for r in order['records'] if core.key(r.get('SKU ID'))}
 needed_refs={core.sku_key(r.get('SKU货号') or r.get('SKC货号')) for t in data if '货号映射' in t['roles'] for r in t['records'] if core.key(r.get('SKU ID')) in selected_ids}
 needed_refs.discard('')
 # Within a workbook, complete cost tables own populated fields. Partial analysis/
 # rate sheets may fill absent fields, but cannot create a second cost for them.
 complete_fields={}
 for table in data:
  if '成本' not in table['roles'] or not set(COSTS).issubset(table['fields']):continue
  for record in table['records']:
   ref=core.sku_key(record.get('SKU货号'))
   if ref not in needed_refs:continue
   complete_fields.setdefault((table['path'],ref),set()).update(name for name in COSTS if core.key(record.get(name)))
 ignored_auxiliary=set()

 def provenance(role,canonical_row,t,r):
  source_map.append({'标准角色':role,'标准行':canonical_row,'原文件':t['path'],'原工作表':t['sheet'],'原行':r['__source_row__']})
 for i,r in enumerate(order['records'],2):provenance('订单',i,order,r)
 for t in data:
  if '货号映射' in t['roles']:
   for r in t['records']:
    sid=core.key(r.get('SKU ID'));ref=core.key(r.get('SKU货号')) or core.key(r.get('SKC货号'))
    if sid and ref:products.add((sid,ref));product_sources.append(((sid,ref),t,r))
  if '成本' in t['roles']:
   for r in t['records']:
    if not core.key(r.get('SKU货号')):continue
    ref=core.sku_key(r['SKU货号'])
    if not ref or ref not in needed_refs:continue
    group=cost_groups.setdefault(ref,{'values':{},'conflicts':False,'sources':[]})
    group['sources'].append((t,r))
    for name in COSTS:
     value=r.get(name)
     if not core.key(value):continue
     if not set(COSTS).issubset(t['fields']) and name in complete_fields.get((t['path'],ref),set()):
      ignored_auxiliary.add((t['path'],t['sheet'],name));continue
     if name in group['values']:
      try:equal=core.number(group['values'][name])==core.number(value)
      except ValueError:equal=core.key(group['values'][name])==core.key(value)
      if not equal:group['conflicts']=True
     else:group['values'][name]=value
  if '价格/结算' in t['roles'] and t is not order:
   label='已结算' if ('Settled' in Path(t['path']).name or '已结算' in t['sheet'] or '已结算' in Path(t['path']).name) and '未结算' not in t['sheet'] else '未结算'
   for r in t['records']:
    if '交易类型' in r and core.key(r['交易类型'])!='销售回款':continue
    pair=(core.key(r.get('订单号')),core.key(r.get('SKU ID')))
    if not all(pair):continue
    settlements[label].append(r);provenance(label,len(settlements[label])+2,t,r);pairs.add(pair)
 # Declaration prices from orders are valid only for that exact order/SKU pair.
 for r in order['records']:
  pair=(core.key(r.get('订单号')),core.key(r.get('SKU ID')))
  if pair not in pairs and core.key(r.get('申报价格')):
   settlements['未结算'].append(r);provenance('未结算',len(settlements['未结算'])+2,order,r);pairs.add(pair)
 for ref,group in cost_groups.items():
  row=[None]*29;row[0]=ref
  for name,col in zip(COSTS,[17,18,19,20,27,28]):row[col]=group['values'].get(name)
  cost_rows.append(row)
  for t,r in group['sources']:provenance('成本',len(cost_rows)+3,t,r)
  if group['conflicts']:
   cost_rows.append(row[:])  # Explicit ambiguity triggers the engine's duplicate-cost safeguard.
   for t,r in group['sources']:provenance('成本冲突',len(cost_rows)+3,t,r)
 product_indices={pair:i for i,pair in enumerate(sorted(products),2)}
 for pair,t,r in product_sources:provenance('货号映射',product_indices[pair],t,r)
 with tempfile.TemporaryDirectory(prefix='ProfitTool-auto-') as directory:
  p=Path(directory);op=p/'orders.xlsx';pp=p/'products.xlsx';up=p/'unsettled.xlsx';sp=p/'settled.xlsx';cp=p/'cost.xlsx'
  headers=order['fields'];write_book(op,[headers]+[[r.get(h) for h in headers] for r in order['records']])
  write_book(pp,[['SKU ID','SKU货号']]+sorted(products))
  heads=['PO单号','SKU ID','件数','申报价格','币种']
  for label,path in [('未结算',up),('已结算',sp)]:
   write_book(path,[heads,heads]+[[r.get('订单号'),r.get('SKU ID'),r.get('应履约件数'),r.get('申报价格'),r.get('币种')] for r in settlements[label]])
  write_book(cp,[['成本表'],[],[]]+cost_rows,'TEMU-半托管 定价表')
  notify('正在核对件数并计算利润')
  result=core.calculate(op,pp,up,sp,cp,month,date_field,freight,currency,refund)
 result['import_report']=[{'文件':x['path'],'工作表':x['sheet'],'表头末行':x['header_row'],'字段':'、'.join(x['fields']),'角色':'、'.join(x['roles'])} for x in report['tables']]
 result['warnings'].extend({'阶段':'成本来源','订单号':'','SKU ID':'','原因':'同一工作簿完整成本表优先；辅助表 '+sheet+' 的 '+name+' 不覆盖主表；文件 '+path} for path,sheet,name in sorted(ignored_auxiliary))
 result['source_map']=source_map
 return result
