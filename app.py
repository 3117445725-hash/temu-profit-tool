import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from pathlib import Path
import threading, queue
from tkinterdnd2 import TkinterDnD, DND_FILES, COPY, REFUSE_DROP
from core import scan_orders, calculate, export_xlsx, number
from updater import check_update,download_update,install_update
import state_store
VERSION='6.2.3'

class App(TkinterDnD.Tk):
    def __init__(self):
        super().__init__()
        self.title('月度利润计算工具 v6.2.3（稳定目录版）'); self.geometry('1000x820'); self.minsize(850,760)
        self._restoring=True;self._state_timer=None
        self.events=queue.Queue(); self.result=None; self.months={}; self.busy=False; self.scanned_path=None
        box=ttk.Frame(self,padding=22); box.pack(fill='both',expand=True)
        ttk.Label(box,text='月度利润计算',font=('Microsoft YaHei UI',22,'bold')).pack(anchor='w')
        ttk.Label(box,text='导入五张表 · 选择月份 · 导出利润明细与异常清单').pack(anchor='w',pady=(4,18))
        self.update_button=ttk.Button(box,text='检查云端更新 · 当前 '+VERSION,command=self.check_cloud);self.update_button.pack(anchor='e')
        self.paths=[];self.drop_widgets=[]
        for title in ['订单表（CSV / Excel）','商品基础信息表','未结算数据表','已结算数据表','成本表']:
            row=ttk.Frame(box); row.pack(fill='x',pady=5)
            label=ttk.Label(row,text=title,width=23);label.pack(side='left')
            v=tk.StringVar(); self.paths.append(v)
            entry=ttk.Entry(row,textvariable=v);entry.pack(side='left',fill='x',expand=True,padx=8)
            button=ttk.Button(row,text='选择或拖入文件',command=lambda v=v:self.pick(v));button.pack(side='right')
            for target in (row,label,entry,button):
                target.drop_target_register(DND_FILES)
                target.dnd_bind('<<DropEnter>>',lambda event:COPY if not self.busy else REFUSE_DROP)
                target.dnd_bind('<<DropPosition>>',lambda event:COPY if not self.busy else REFUSE_DROP)
                target.dnd_bind('<<Drop>>',lambda event,v=v:self.drop_file(event,v))
                self.drop_widgets.append((target,v))
        row=ttk.Frame(box); row.pack(fill='x',pady=16)
        ttk.Button(row,text='识别订单月份',command=self.scan).pack(side='left')
        ttk.Label(row,text='  日期依据 ').pack(side='left')
        self.date=tk.StringVar(value='订单创建时间'); self.dc=ttk.Combobox(row,textvariable=self.date,state='readonly',width=19); self.dc.pack(side='left'); self.dc.bind('<<ComboboxSelected>>',self.refresh_month)
        ttk.Label(row,text='  月份 ').pack(side='left')
        self.mon=tk.StringVar(); self.mc=ttk.Combobox(row,textvariable=self.mon,state='readonly',width=12); self.mc.pack(side='left')
        self.run=ttk.Button(row,text='计算利润',command=self.compute); self.run.pack(side='right')
        fr=ttk.Frame(box);fr.pack(fill='x',pady=(0,12))
        ttk.Label(fr,text='当月运费收入（合计，仅加一次）').pack(side='left')
        self.freight=tk.StringVar(value='0');ttk.Entry(fr,textvariable=self.freight,width=18).pack(side='left',padx=8)
        self.currency=tk.StringVar(value='USD');ttk.Combobox(fr,textvariable=self.currency,values=['USD','CNY','EUR','GBP','CAD','AUD'],width=8).pack(side='left')
        rr=ttk.Frame(box);rr.pack(fill='x',pady=(0,12))
        ttk.Label(rr,text='当月预计退款比例').pack(side='left')
        self.refund=tk.StringVar(value='10');ttk.Entry(rr,textvariable=self.refund,width=12).pack(side='left',padx=8)
        ttk.Label(rr,text='%（填10表示10%，可按月修改）').pack(side='left')
        ttk.Label(box,text='口径：七项金额相加；最终利润 = 利润合计 + 手填运费收入。\n货号优先 E 列，空白取 D 列，取开头6位数字；结算按订单号 + SKU ID 唯一匹配。',wraplength=920).pack(anchor='w',pady=(0,12))
        self.status=tk.StringVar(value='请选择五个文件，然后识别订单月份。'); ttk.Label(box,textvariable=self.status,wraplength=920).pack(anchor='w')
        self.bar=ttk.Progressbar(box,mode='indeterminate'); self.bar.pack(fill='x',pady=8)
        self.log=tk.Text(box,height=10,wrap='word',font=('Microsoft YaHei UI',10));self.log.pack(fill='both',expand=True)
        actions=ttk.Frame(box);actions.pack(side='bottom',fill='x',pady=10)
        self.save=ttk.Button(actions,text='导出 Excel 报告',command=self.export,state='disabled');self.save.pack(side='right')
        self.clear_button=ttk.Button(actions,text='清空记录',command=self.clear_records);self.clear_button.pack(side='right',padx=12)
        self.freight.trace_add('write',self.freight_changed);self.currency.trace_add('write',self.freight_changed)
        self.refund.trace_add('write',self.freight_changed)
        self.restore_state()
        self._restoring=False
        for v in self.paths+[self.date,self.mon,self.freight,self.currency,self.refund]:v.trace_add('write',self.input_changed)
        self.status.trace_add('write',self.schedule_state)
        self.log.bind('<<Modified>>',self.log_changed)
        self.log.edit_modified(False)
        self.protocol('WM_DELETE_WINDOW',self.close_app)
        self.after(100,self.poll)
    def restore_state(self):
        data=state_store.load()
        try:
            for v,value in zip(self.paths,data.get('paths',[])):v.set(value)
            for name in ['date','mon','freight','currency','refund']:
                if name in data:getattr(self,name).set(data[name])
            self.months=data.get('months',{});self.scanned_path=data.get('scanned_path')
            self.dc['values']=list(self.months);self.mc['values']=self.months.get(self.date.get(),[])
            self.result=data.get('result');self.log.insert('1.0',data.get('log',''))
            if data.get('status'):self.status.set(data['status'])
            self.save.config(state='normal' if self.result else 'disabled')
        except (TypeError,ValueError,tk.TclError):self.result=None
    def save_state(self):
        self._state_timer=None
        try:
            state_store.save({'paths':[v.get() for v in self.paths],**{n:getattr(self,n).get() for n in ['date','mon','freight','currency','refund']},'months':self.months,'scanned_path':self.scanned_path,'result':self.result,'log':self.log.get('1.0','end-1c'),'status':self.status.get()})
            return True
        except Exception as e:
            messagebox.showerror('保存记录失败',str(e));return False
    def schedule_state(self,*_):
        if self._restoring:return
        if self._state_timer:self.after_cancel(self._state_timer)
        self._state_timer=self.after(400,self.save_state)
    def input_changed(self,*_):
        if self._restoring:return
        self.freight_changed();self.schedule_state()
    def input_signature(self):
        return tuple(v.get() for v in self.paths+[self.date,self.mon,self.freight,self.currency,self.refund])
    def log_changed(self,*_):
        if self.log.edit_modified():self.log.edit_modified(False);self.schedule_state()
    def close_app(self):
        if self.save_state():self.destroy()
    def clear_records(self):
        if self.busy:return
        self.result=None;self.log.delete('1.0','end');self.save.config(state='disabled');self.bar.stop();self.bar['value']=0
        self.status.set('计算结果和异常记录已清空；已选文件及参数保留。')
        self.save_state()
    def check_cloud(self):
        if not self.busy:self.task(lambda:check_update(VERSION),self.cloud_checked)
    def cloud_checked(self,manifest):
        if self.result:self.save.config(state='normal')
        if manifest is None:
            self.status.set('当前已是云端最新版本 '+VERSION);return
        self.status.set('发现新版本 '+manifest['version'])
        if messagebox.askyesno('云端更新','发现版本 '+manifest['version']+'，是否下载、校验并重启安装？请先导出需要保存的报告。'):
            self.task(lambda:download_update(manifest),self.cloud_downloaded)
    def cloud_downloaded(self,path):
        try:
            if not self.save_state():return
            install_update(path);self.destroy()
        except Exception as e:messagebox.showerror('安装更新失败',str(e))
    def freight_changed(self,*_):
        if self._restoring:return
        if self.result:
            self.result=None;self.save.config(state='disabled');self.status.set('输入参数已修改，请重新计算后导出。')
    def pick(self,v):
        p=filedialog.askopenfilename(filetypes=[('数据文件','*.xlsx *.csv'),('全部文件','*.*')])
        if p:self.set_path(v,p)
    def set_path(self,v,p):
        if self.busy:return
        v.set(p);self.result=None;self.save.config(state='disabled')
        if v is self.paths[0]:self.months={};self.mon.set('');self.mc['values']=[];self.scanned_path=None
    def drop_file(self,event,v):
        if self.busy:return REFUSE_DROP
        files=self.tk.splitlist(event.data)
        if len(files)!=1:return messagebox.showinfo('拖拽文件','每个输入框请放入一个对应文件。')
        p=Path(files[0])
        allowed={'.xlsx','.csv'} if v is self.paths[0] else {'.xlsx'}
        if not p.is_file() or p.suffix.lower() not in allowed:return messagebox.showerror('文件无效','订单支持 CSV/XLSX，其余表请使用 XLSX。')
        self.set_path(v,str(p));self.status.set('已拖入：'+p.name);return COPY
    def task(self,fn,done):
        if self.busy:return
        self.busy=True
        self.run.config(state='disabled');self.save.config(state='disabled');self.bar.start();self.status.set('正在读取和核对，请稍候…')
        def worker():
            try:self.events.put((done,fn(),None))
            except Exception as e:self.events.put((done,None,str(e)))
        threading.Thread(target=worker,daemon=True).start()
    def poll(self):
        try:
            done,data,error=self.events.get_nowait();self.busy=False;self.bar.stop();self.run.config(state='normal')
            if error:self.status.set('操作失败：'+error);messagebox.showerror('操作失败',error)
            else:done(data)
        except queue.Empty:pass
        self.after(100,self.poll)
    def scan(self):
        if self.busy:return
        if not Path(self.paths[0].get()).is_file():return messagebox.showinfo('选择订单表','请先选择订单表。')
        path=self.paths[0].get();self.scanned_path=path
        self.task(lambda:scan_orders(path),self.scanned)
    def scanned(self,data):
        fields,self.months=data;self.dc['values']=fields
        self.date.set('订单创建时间' if '订单创建时间' in fields else fields[0] if fields else '')
        self.refresh_month();self.status.set('月份已识别，可选择月份并计算。')
    def refresh_month(self,*_):
        values=self.months.get(self.date.get(),[]);self.mc['values']=values;self.mon.set(values[-1] if values else '')
    def compute(self):
        if self.busy:return
        paths=[v.get() for v in self.paths]
        if not all(Path(p).is_file() for p in paths):return messagebox.showinfo('缺少文件','请选择全部五个有效文件。')
        if not self.mon.get():return messagebox.showinfo('选择月份','请先识别并选择订单月份。')
        if paths[0]!=self.scanned_path:return messagebox.showinfo('订单文件已更换','请重新识别订单月份。')
        try:
            freight=number(self.freight.get());currency=self.currency.get().strip().upper()
            if freight<0 or not currency:raise ValueError('运费收入须为非负金额，并填写币种')
            refund=number(self.refund.get().strip().removesuffix('%'))
            if not 0<=refund<=100:raise ValueError('预计退款比例须在0到100之间')
        except ValueError as e:return messagebox.showerror('输入无效',str(e))
        month,date=self.mon.get(),self.date.get();self.result=None
        self._calculation_inputs=self.input_signature()
        self.task(lambda:calculate(*paths,month,date,freight,currency,refund),self.calculated)
    def calculated(self,r):
        if self.input_signature()!=self._calculation_inputs:
            self.result=None;self.save.config(state='disabled');self.status.set('计算期间输入已修改，请重新计算。');self.schedule_state();return
        self.result=r;self.save.config(state='normal');self.log.delete('1.0','end')
        self.status.set(f"{r['month']}：选中 {r['selected_orders']} 个唯一订单/SKU，正常 {len(r['details'])} 个，估算 {r['estimated_orders']} 个，未计入 {r['failed_orders']} 个；异常提示 {len(r['exceptions'])} 条，处理提示 {len(r['warnings'])} 条。")
        for t in r['totals']:self.log.insert('end',f"{t['币种']} 正常：{t['正常计算利润']:,.2f} + 估算：{t['估算利润']:,.2f} = 利润：{t['利润']:,.2f} + 运费收入：{t['手填运费收入']:,.2f} = 最终利润：{t['最终利润']:,.2f}\n")
        for d in r['estimated']:self.log.insert('end',f"[估算10%] {d['订单号']} / {d['SKU ID']}：{d['估算原因']}；估算利润 {d['估算利润']:,.2f}\n\n")
        for i in r['exceptions']:self.log.insert('end',f"[{i['阶段']}] {i['订单号']} / {i['SKU ID']}：{i['原因']}\n\n")
        if not r['details'] and not r['estimated']:self.log.insert('end','没有可计入利润的记录，请检查异常清单。\n')
        self.schedule_state()
    def export(self):
        if not self.result:return
        p=filedialog.asksaveasfilename(defaultextension='.xlsx',initialfile='利润报告_'+self.result['month']+'.xlsx',filetypes=[('Excel','*.xlsx')])
        if p:
            try:export_xlsx(self.result,p);messagebox.showinfo('导出完成',p)
            except Exception as e:messagebox.showerror('导出失败',str(e))

if __name__=='__main__':
    from normal_user import ensure_normal
    try:
        if ensure_normal():App().mainloop()
    except Exception as e:
        root=tk.Tk();root.withdraw();messagebox.showerror('启动失败',str(e));root.destroy()
