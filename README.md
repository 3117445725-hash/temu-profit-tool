# 月度利润计算工具

Windows 本地桌面工具。支持 CSV/XLSX 订单、商品信息、已结算/未结算及成本表导入，按月计算利润。文件在本地处理，不上传业务数据。

## 使用

下载 Releases 中的 ProfitTool-portable.zip，完整解压后运行 ProfitTool.exe；必须保留旁边的 _internal 文件夹。旧单文件版本须先手动迁移一次。支持拖入文件、手填当月退款百分比和运费收入、Excel 导出、检查云端更新。

货号取开头六位数字并保留前导零。结算按订单号与 SKU ID 匹配，读取实际合并单元格；同状态同币种同单价的多行结算累加件数。

单件成本为采购价、头程、尾程、处理费、仓储费、退款成本和资金成本之和。退款成本=申报价×自定义比例。利润=(申报价-单件成本)×件数。最终利润为同币种利润合计加手填当月运费一次。

## 更新

工具从本库 Releases 的 latest.json 获取版本、HTTPS下载地址和 SHA256。下载校验成功后，确认重启安装；更新前保留 .previous 备份。更新不会上传工作簿。

## 开发发布

Python 3.12；依赖 openpyxl、tkinterdnd2、PyInstaller。更新源码中的 VERSION，重新打包，在新 Release 上传 ProfitTool.exe、源码 ZIP、包含 version/url/sha256 的 latest.json。不要上传业务数据。

构建示例：`pyinstaller --onedir --windowed --collect-all tkinterdnd2 --name ProfitTool app.py`。

未匹配记录不计入利润，须核对异常清单。不同币种不换汇。平台列布局变化需要更新适配。

