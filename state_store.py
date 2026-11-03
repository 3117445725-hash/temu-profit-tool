"""Private per-user state, independent of the installed application directory."""
import json,os,tempfile
from decimal import Decimal
from pathlib import Path

def state_path():
    return Path(os.environ.get('LOCALAPPDATA',str(Path.home()/'AppData'/'Local')))/'ProfitTool'/'state.json'
def encode(value):
    if isinstance(value,Decimal):return {'__profittool_decimal__':str(value)}
    raise TypeError(type(value).__name__)
def decode(value):
    if set(value)=={'__profittool_decimal__'}:return Decimal(value['__profittool_decimal__'])
    return value
def load(path=None):
    try:
        data=json.loads(Path(path or state_path()).read_text(encoding='utf-8'),object_hook=decode)
        return data if isinstance(data,dict) else {}
    except (OSError,ValueError,TypeError):return {}
def save(data,path=None):
    target=Path(path or state_path());target.parent.mkdir(parents=True,exist_ok=True)
    text=json.dumps(data,ensure_ascii=False,default=encode,allow_nan=False)
    fd,name=tempfile.mkstemp(prefix='state-',suffix='.tmp',dir=target.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as stream:
            stream.write(text);stream.flush();os.fsync(stream.fileno())
        os.replace(name,target)
    finally:
        Path(name).unlink(missing_ok=True)
