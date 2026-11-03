"""Local, auditable profit calculation; source workbooks are never modified."""
import csv
from collections import defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
import openpyxl

FIELDS = ['FOB采购价','头程费用','尾程运费','处理费','美仓仓储费','预计退款成本','资金成本']
def key(v):
    return str(v).strip() if v is not None else ''

def sku_key(v):
    s=key(v)[:6]
    return s if len(s)==6 and s.isascii() and s.isdigit() else ''

def number(v):
    if v is None or key(v) == '' or isinstance(v,bool): raise ValueError('数值为空')
    s=key(v).replace(',','')
    try: d=Decimal(s[:-1])/100 if s.endswith('%') else Decimal(s)
    except InvalidOperation: raise ValueError('不是有效数值: '+s)
    if not d.is_finite(): raise ValueError('非有限数值')
    return d

def rows(path, sheet=0, cached=True):
    w=openpyxl.load_workbook(path,read_only=True,data_only=cached)
    try:
        s=w.worksheets[sheet] if isinstance(sheet,int) else w[sheet]
        yield from s.iter_rows(values_only=True)
    finally: w.close()

def settlement_rows(path):
    w=openpyxl.load_workbook(path,data_only=True)
    try:
        s=w.worksheets[0]
        merged={}
        for area in s.merged_cells.ranges:
            for row in range(area.min_row,area.max_row+1):
                for col in range(area.min_col,area.max_col+1):
                    merged[(row,col)]=s.cell(area.min_row,area.min_col).value
        for row in s.iter_rows():
            yield tuple(merged.get((c.row,c.column),c.value) if hasattr(c,'row') else None for c in row)
    finally:w.close()

def orders(path):
    if str(path).lower().endswith('.csv'):
        for enc in ['utf-8-sig','gb18030']:
            try:
                with open(path,encoding=enc,newline='') as f: return list(csv.DictReader(f))
            except UnicodeError: pass
        raise ValueError('无法识别订单 CSV 编码')
    it=iter(rows(path)); h=[key(x) for x in next(it)]
    return [dict(zip(h,r)) for r in it if any(x is not None for x in r)]

def month(v):
    if isinstance(v,datetime): return v.strftime('%Y-%m')
    s=key(v).replace('/','-')
    try: return datetime.fromisoformat(s).strftime('%Y-%m')
    except ValueError: raise ValueError('无效日期: '+s)

def scan_orders(path):
    data=orders(path)
    if not data: raise ValueError('订单表为空')
    dates=[h for h in data[0] if '时间' in h or '日期' in h]
    months={}
    for h in dates:
        found=set()
        for r in data:
            try: found.add(month(r.get(h)))
            except ValueError: pass
        months[h]=sorted(found)
    return dates,months

def calculate(order_path,product_path,unsettled_path,settled_path,cost_path,selected_month,date_field='订单创建时间',freight_income='0',freight_currency='USD',refund_percent='10'):
    refund_percent=number(key(refund_percent).removesuffix('%'))
    if not Decimal(0)<=refund_percent<=Decimal(100): raise ValueError('预计退款比例须在0到100之间')
    refund_rate=refund_percent/100
    freight_income=number(freight_income)
    if freight_income<0: raise ValueError('运费收入不能为负')
    freight_currency=key(freight_currency).upper()
    if not freight_currency: raise ValueError('请选择运费收入币种')
    issues=[]; details=[]; warnings=[]; estimated=[];quantity_checks=[]
    def issue(stage,order='',sku='',reason='',order_qty=None): issues.append({'阶段':stage,'订单号':order,'SKU ID':sku,'原因':reason,'订单应履约件数':order_qty})
    products=defaultdict(set)
    product_it=iter(rows(product_path));header=[key(v) for v in next(product_it)]
    if 'SKU ID' not in header:raise ValueError('商品表缺少SKU ID表头；请选择商品基础信息或产品价格导出表')
    product_id=header.index('SKU ID')
    primary=next((header.index(name) for name in ['SKU货号','货号'] if name in header),None)
    fallback=header.index('SKC货号') if 'SKC货号' in header else None
    if primary is None and fallback is None:raise ValueError('商品表缺少SKU货号、货号或SKC货号表头')
    for r in product_it:
        if len(r)>product_id and key(r[product_id]):
            ref=key(r[primary]) if primary is not None and len(r)>primary else ''
            if not ref and fallback is not None and len(r)>fallback:ref=key(r[fallback])
            products[key(r[product_id])].add(sku_key(ref))
    settlements=defaultdict(list)
    for path,label,qi,pi,ci in [(unsettled_path,'未结算',3,4,5),(settled_path,'已结算',4,5,7)]:
        current=''
        oi,si=0,1;trade_index=None;heads=[]
        for n,r in enumerate(settlement_rows(path),1):
            if n<=2:
                heads.append(r)
                if n==2:
                    columns={key(v):i for head in heads for i,v in enumerate(head) if key(v)}
                    if 'SKU ID' in columns:
                        required=['PO单号','SKU ID','件数','申报价格']
                        missing=[x for x in required if x not in columns]
                        if missing:raise ValueError(label+'表缺少字段：'+','.join(missing))
                        oi,si,qi,pi=[columns[x] for x in required]
                        ci=columns.get('币种')
                        trade_index=columns.get('交易类型')
                continue
            if not any(x is not None for x in r): continue
            if key(r[oi]): current=key(r[oi])
            if trade_index is not None and key(r[trade_index])!='销售回款':continue
            sku=key(r[si]) if len(r)>si else ''
            if not sku: continue
            try:
                q=number(r[qi]) if len(r)>qi and key(r[qi]) else None
                p=number(r[pi]); currency=key(r[ci]) if ci is not None and len(r)>ci else ''
                if not currency:
                    currency=freight_currency
                    warnings.append({'阶段':'统一币种','订单号':current,'SKU ID':sku,'原因':label+'第'+str(n)+'行未填币种，按工具统一单位 '+currency+' 处理，未进行换汇'})
                if (q is not None and (q<=0 or q!=q.to_integral_value())) or p<0: raise ValueError('件数必须为正整数、申报价格不能为负')
                if not current: raise ValueError('缺少订单号')
                settlements[(current,sku)].append((q,p,currency,label,n))
            except (ValueError,IndexError) as e: settlements[(current,sku)].append(('ERROR',str(e),label,n))
    costs=defaultdict(list)
    for n,r in enumerate(rows(cost_path,'TEMU-半托管 定价表'),1):
        if n<=3 or not key(r[0]): continue
        normalized=sku_key(r[0])
        if normalized: costs[normalized].append((n,r))
    seen=set()
    for n,r in enumerate(orders(order_path),2):
        order,sku=key(r.get('订单号')),key(r.get('SKU ID'))
        try:
            if month(r.get(date_field))!=selected_month: continue
        except ValueError as e: issue('订单日期',order,sku,str(e));continue
        pair=(order,sku)
        if pair in seen:
            warnings.append({'阶段':'订单去重','订单号':order,'SKU ID':sku,'原因':'重复订单号+SKU ID，仅计算一次；件数取结算表'})
            continue
        seen.add(pair)
        try:
            order_qty=number(r.get('应履约件数'))
            if order_qty<=0 or order_qty!=order_qty.to_integral_value():order_qty=None
        except ValueError:order_qty=None
        quantity_source='结算表'
        q=p=currency=status=source_row=None
        try:
            if not order or not sku: raise ValueError('缺少订单号或SKU ID')
            matches=settlements.get(pair,[])
            settled=[m for m in matches if (m[2] if m[0]=='ERROR' else m[3])=='已结算']
            unsettled=[m for m in matches if (m[2] if m[0]=='ERROR' else m[3])=='未结算']
            if settled and unsettled:
                matches=settled
                warnings.append({'阶段':'跨表去重','订单号':order,'SKU ID':sku,'原因':'两表均出现，优先已结算，仅计一次；未结算记录不再计入'})
            if len(matches)>1 and all(m[0] is not None and m[0]!='ERROR' for m in matches) and len({(m[1],m[2],m[3]) for m in matches})==1:
                first=matches[0]
                warnings.append({'阶段':'结算合并','订单号':order,'SKU ID':sku,'原因':'同状态、同币种、同单价的多行结算合并件数；来源行 '+','.join(str(m[4]) for m in matches)})
                matches=[(sum((m[0] for m in matches),Decimal(0)),first[1],first[2],first[3],','.join(str(m[4]) for m in matches))]
            if len(matches)!=1:
                same_order=[s for o,s in settlements if o==order]
                same_sku=[o for o,s in settlements if s==sku]
                evidence='；同订单其他SKU：'+(','.join(sorted(set(same_order))) or '无')+'；同SKU其他订单：'+(','.join(sorted(set(same_sku))[:5]) or '无')
                if matches:evidence+='；匹配记录：'+' | '.join(str(m) for m in matches)
                raise ValueError('结算匹配数量为 '+str(len(matches))+'，需唯一匹配'+evidence+'；请核对结算店铺、日期范围及订单/SKU组合；不自动改用其他订单')
            match=matches[0]
            if match[0]=='ERROR': raise ValueError('结算数值错误: '+match[1]+'；来源 '+match[2]+' 第'+str(match[3])+'行，请核对件数、申报价格和币种')
            q,p,currency,status,source_row=match
            qty_status='一致' if q is not None and order_qty is not None and q==order_qty else '不一致' if q is not None and order_qty is not None else '结算缺件数' if q is None else '订单缺件数'
            quantity_checks.append({'订单号':order,'SKU ID':sku,'订单应履约件数':order_qty,'结算件数':q,'差额(结算-订单)':q-order_qty if q is not None and order_qty is not None else None,'采用件数':q,'件数来源':quantity_source,'对比结果':qty_status,'结算状态':status,'结算源行':source_row})
            if qty_status=='一致':q=order_qty;quantity_source='订单表应履约件数（与结算一致）'
            if qty_status=='不一致':warnings.append({'阶段':'件数核对','订单号':order,'SKU ID':sku,'原因':'订单件数 '+str(order_qty)+' 与结算件数 '+str(q)+' 不一致；按结算件数计算，请核对部分履约、取消或拆单'})
            if q is None and order_qty is not None:
                q=order_qty;quantity_source='订单表应履约件数'
                warnings.append({'阶段':'件数补充','订单号':order,'SKU ID':sku,'原因':'结算件数空白，采用订单表应履约件数 '+str(q)})
            quantity_checks[-1].update({'采用件数':q,'件数来源':quantity_source if q is not None else '缺件数'})
            if q is None:raise ValueError('结算表缺少件数；按申报价格10%估算，未乘件数')
            order_ref=sku_key(r.get('SKU货号') or r.get('货号'))
            refs={order_ref} if order_ref else products.get(sku,set())
            if not refs:raise ValueError('商品表未找到SKU ID '+sku+'；请核对店铺或补充该SKU的商品基础信息')
            if len(refs)!=1:raise ValueError('SKU ID '+sku+' 对应多个六位货号：'+','.join(sorted(refs))+'；请核实商品表对应关系')
            if not next(iter(refs),''):raise ValueError('SKU ID '+sku+' 的E列货号（空时取D列）不是以6位数字开头；请修正商品表货号')
            ref=next(iter(refs))
            found=costs.get(ref,[])
            if len(found)!=1: raise ValueError('成本货号匹配数量为 '+str(len(found))+'；六位货号 '+ref+'；成本来源行：'+(','.join(str(x[0]) for x in found) or '无')+'；请在成本表A列补充或核对唯一对应记录')
            costrow,c=found[0]
            try: fob,first,last,handling,storage_rate,capital_rate=[number(c[i]) for i in [17,18,19,20,27,28]]
            except (ValueError,IndexError) as e: raise ValueError('成本表第%d行缓存数值缺失或无效: %s'%(costrow,e))
            values=[fob,first,last,handling,p*storage_rate,p*refund_rate,p*capital_rate]
            total=sum(values,Decimal(0));profit=(p-total)*q
            d={'订单号':order,'SKU ID':sku,'SKU货号':ref,'月份':selected_month,'结算状态':status,'币种':currency,'件数':q,'申报价格':p,'件数来源':quantity_source}
            d.update(zip(FIELDS,values));d.update({'资金成本率':capital_rate,'美仓仓储费率':storage_rate,'单件总成本':total,'利润':profit,'成本源行':costrow,'结算源行':source_row})
            details.append(d)
        except ValueError as e:
            if p is not None:
                estimated.append({'订单号':order,'SKU ID':sku,'月份':selected_month,'结算状态':status,'币种':currency,'件数':q,'申报价格':p,'件数来源':quantity_source if q is not None else '无件数','估算比例':Decimal('0.10'),'估算利润':p*Decimal('0.10')*(q if q is not None else Decimal(1)),'估算依据':'申报价格×10%×件数' if q is not None else '申报价格×10%（缺件数）','估算原因':str(e),'结算源行':source_row})
            else:
                quantity_checks.append({'订单号':order,'SKU ID':sku,'订单应履约件数':order_qty,'结算件数':None,'差额(结算-订单)':None,'采用件数':order_qty,'件数来源':'订单表（无申报价格，未计算）','对比结果':'无可用结算，无法对比','结算状态':'','结算源行':None})
                issue('匹配/计算',order,sku,str(e)+('；已读取订单应履约件数 '+str(order_qty)+'，但缺少可靠申报价格，仍不计入利润' if order_qty is not None else ''),order_qty)
    summary={}
    for d in details:
        k=(d['SKU货号'],d['币种']);s=summary.setdefault(k,{'SKU货号':k[0],'币种':k[1],'件数':Decimal(0),'申报总额':Decimal(0),'总成本':Decimal(0),'利润':Decimal(0)})
        s['件数']+=d['件数'];s['申报总额']+=d['申报价格']*d['件数'];s['总成本']+=d['单件总成本']*d['件数'];s['利润']+=d['利润']
    totals={}
    for s in summary.values(): totals[s['币种']]=totals.get(s['币种'],Decimal(0))+s['利润']
    estimates=defaultdict(lambda:Decimal(0))
    for d in estimated:estimates[d['币种']]+=d['估算利润'];totals.setdefault(d['币种'],Decimal(0))
    totals.setdefault(freight_currency,Decimal(0))
    final=[{'币种':c,'正常计算利润':v,'估算利润':estimates[c],'利润':v+estimates[c],'手填运费收入':freight_income if c==freight_currency else Decimal(0),'最终利润':v+estimates[c]+(freight_income if c==freight_currency else Decimal(0))} for c,v in totals.items()] if details or estimated else []
    return {'details':details,'summary':list(summary.values()),'totals':final,'refund_percent':refund_percent,'exceptions':issues,'warnings':warnings,'quantity_checks':quantity_checks,'estimated':estimated,'estimated_orders':len(estimated),'failed_orders':len(seen)-len(details)-len(estimated),'selected_orders':len(seen),'month':selected_month,'date_field':date_field}

def export_xlsx(result,path):
    w=openpyxl.Workbook();w.remove(w.active)
    from openpyxl.styles import Font,PatternFill
    for title,data in [('利润明细',result['details']),('估算利润明细',result.get('estimated',[])),('SKU汇总',result['summary']),('利润合计',result.get('totals',[])),('异常清单',result['exceptions']),('处理提示',result.get('warnings',[])),('件数对比',result.get('quantity_checks',[])),('自动识别报告',result.get('import_report',[])),('数据来源追溯',result.get('source_map',[]))]:
        s=w.create_sheet(title)
        if data:
            h=list(data[0]);s.append(h)
            for d in data:
                s.append([float(d[k]) if isinstance(d[k],Decimal) else d[k] for k in h])
                # Treat imported identifiers and messages as text, never executable formulas.
                for cell in s[s.max_row]:
                    if isinstance(cell.value,str): cell.data_type='s'
            s.auto_filter.ref=s.dimensions
            for c in s[1]: c.font=Font(bold=True,color='FFFFFF');c.fill=PatternFill('solid',fgColor='17365D')
            for col in s.columns: s.column_dimensions[col[0].column_letter].width=min(45,max(14,len(str(col[0].value))*2+3))
            for row in s.iter_rows(min_row=2):
                for c in row:
                    if isinstance(c.value,float): c.number_format='0.00####'
        else:s.append(['无数据'])
        s.freeze_panes='A2'
    s=w.create_sheet('计算说明');s.append(['月份',result['month']]);s.append(['日期依据',result['date_field']]);s.append(['规则','总成本为七项金额之和；费率仅展示。最终利润=利润合计+手填运费收入；运费按月仅加一次，不分摊到SKU。']);s.append(['异常处理','有可靠结算价格和件数但商品/成本匹配失败时按申报价格×10%×件数估算，单列估算明细并计入合计；无可靠结算仍异常，不同币种分别汇总。']);s.column_dimensions['B'].width=110
    s.append(['预计退款比例',str(result.get('refund_percent',10))+'%（手填）；预计退款成本=申报价格×此比例，不读取成本表Y列。'])
    s.append(['货号匹配','商品货号与成本表货号均取开头6位数字，保留前导零；截取后多个成本记录仍提示异常。'])
    w.save(path)


