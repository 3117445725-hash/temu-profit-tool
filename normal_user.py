"""Run the desktop app with Explorer's ordinary user token for OLE drops."""
import ctypes
from ctypes import wintypes as W
import csv,io,subprocess,sys,os

class STARTUPINFO(ctypes.Structure):
    _fields_=[('cb',W.DWORD),('lpReserved',W.LPWSTR),('lpDesktop',W.LPWSTR),('lpTitle',W.LPWSTR),('dwX',W.DWORD),('dwY',W.DWORD),('dwXSize',W.DWORD),('dwYSize',W.DWORD),('dwXCountChars',W.DWORD),('dwYCountChars',W.DWORD),('dwFillAttribute',W.DWORD),('dwFlags',W.DWORD),('wShowWindow',W.WORD),('cbReserved2',W.WORD),('lpReserved2',ctypes.POINTER(ctypes.c_byte)),('hStdInput',W.HANDLE),('hStdOutput',W.HANDLE),('hStdError',W.HANDLE)]
class PROCESSINFO(ctypes.Structure):
    _fields_=[('hProcess',W.HANDLE),('hThread',W.HANDLE),('dwProcessId',W.DWORD),('dwThreadId',W.DWORD)]

def launch_normal(argv):
    k=ctypes.WinDLL('kernel32',use_last_error=True);a=ctypes.WinDLL('advapi32',use_last_error=True)
    k.OpenProcess.restype=W.HANDLE;k.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD]
    k.CloseHandle.argtypes=[W.HANDLE]
    a.OpenProcessToken.argtypes=[W.HANDLE,W.DWORD,ctypes.POINTER(W.HANDLE)]
    a.GetTokenInformation.argtypes=[W.HANDLE,ctypes.c_int,W.LPVOID,W.DWORD,ctypes.POINTER(W.DWORD)]
    a.DuplicateTokenEx.argtypes=[W.HANDLE,W.DWORD,W.LPVOID,ctypes.c_int,ctypes.c_int,ctypes.POINTER(W.HANDLE)]
    a.CreateProcessWithTokenW.argtypes=[W.HANDLE,W.DWORD,W.LPCWSTR,W.LPWSTR,W.DWORD,W.LPVOID,W.LPCWSTR,ctypes.POINTER(STARTUPINFO),ctypes.POINTER(PROCESSINFO)]
    session=W.DWORD();k.ProcessIdToSessionId(os.getpid(),ctypes.byref(session))
    tasks=subprocess.check_output(['tasklist','/FI','IMAGENAME eq explorer.exe','/FO','CSV','/NH'],text=True,creationflags=0x08000000)
    for row in csv.reader(io.StringIO(tasks)):
        if not row or row[0].lower()!='explorer.exe':continue
        pid=int(row[1]);other=W.DWORD();k.ProcessIdToSessionId(pid,ctypes.byref(other))
        if other.value!=session.value:continue
        h=k.OpenProcess(0x1000,False,pid);token=W.HANDLE();dup=W.HANDLE()
        try:
            if not a.OpenProcessToken(h,0x0002|0x0008,ctypes.byref(token)):continue
            elevated=W.DWORD();size=W.DWORD()
            if not a.GetTokenInformation(token,20,ctypes.byref(elevated),4,ctypes.byref(size)) or elevated.value:continue
            if not a.DuplicateTokenEx(token,0xF01FF,None,2,1,ctypes.byref(dup)):raise ctypes.WinError(ctypes.get_last_error())
            si=STARTUPINFO();si.cb=ctypes.sizeof(si);si.lpDesktop='winsta0\\default';pi=PROCESSINFO()
            cmd=ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
            env=dict(os.environ);env['PYINSTALLER_RESET_ENVIRONMENT']='1'
            env_block=ctypes.create_unicode_buffer('\0'.join(k+'='+v for k,v in sorted(env.items(),key=lambda x:x[0].upper()))+'\0\0')
            if not a.CreateProcessWithTokenW(dup,0,None,cmd,0x400,env_block,os.getcwd(),ctypes.byref(si),ctypes.byref(pi)):raise ctypes.WinError(ctypes.get_last_error())
            k.CloseHandle(pi.hThread);k.CloseHandle(pi.hProcess);return pi.dwProcessId
        finally:
            if dup:k.CloseHandle(dup)
            if token:k.CloseHandle(token)
            if h:k.CloseHandle(h)
    raise RuntimeError('无法获取当前桌面的普通权限，请从资源管理器直接启动工具。')

def ensure_normal():
    if os.name=='nt' and ctypes.windll.shell32.IsUserAnAdmin():
        argv=[sys.executable]+sys.argv[1:] if getattr(sys,'frozen',False) else [sys.executable]+sys.argv
        launch_normal(argv)
        return False
    return True

