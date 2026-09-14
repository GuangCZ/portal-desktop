# Launch snapshot adapter from the bundled Heart Portal (MIT).
import ctypes, json, os, subprocess, sys
from pathlib import Path

def executable_path(pid):
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
    libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    libproc.proc_pidpath.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(4096)
    if libproc.proc_pidpath(pid, buffer, len(buffer)) > 0:
        return Path(os.fsdecode(buffer.value)).resolve()
    return None


def process_identity(pid):
    executable = executable_path(pid)
    if not executable:
        return None
    started = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='],
                             env=dict(os.environ, TZ='UTC', LC_ALL='C'),
                             capture_output=True, text=True).stdout.strip()
    return {'pid': pid, 'executable': str(executable), 'started': started} if started else None


def identity_alive(identity):
    return bool(identity and process_identity(identity['pid']) == identity)


def launch_snapshot(identity):
    """Read a live legacy Portal's argv/cwd/environment without logging or saving secrets."""
    if not identity_alive(identity):
        raise RuntimeError('Original Portal exited before its launch settings could be captured.')
    # Darwin KERN_PROCARGS2 preserves argument boundaries (unlike ps command=).
    # Layout: argc, executable path, NUL padding, argc strings, environment.
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
                           ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
    libc.sysctl.restype = ctypes.c_int
    mib = (ctypes.c_int * 3)(1, 49, identity['pid'])  # CTL_KERN, KERN_PROCARGS2
    size = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value < 5:
        raise RuntimeError('Cannot read the original Portal launch settings; Portal was left running.')
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        raise RuntimeError('Cannot read the original Portal launch settings; Portal was left running.')
    data = buffer.raw[:size.value]
    try:
        argc = int.from_bytes(data[:4], sys.byteorder)
        position = data.index(b'\0', 4) + 1
        while data[position] == 0:
            position += 1
        arguments = []
        for _ in range(argc):
            end = data.index(b'\0', position)
            arguments.append(os.fsdecode(data[position:end]))
            position = end + 1
        environment = dict(value.split('=', 1) for value in
                           map(os.fsdecode, data[position:].split(b'\0')) if '=' in value)
        if not arguments:
            raise ValueError('Empty argument list')
    except (ValueError, IndexError):
        raise RuntimeError('Original Portal launch settings are incomplete; Portal was left running.') from None
    # Fixed-width Darwin ABI from sys/proc_info.h: vnode_info contains a
    # 136-byte vinfo_stat followed by 16 bytes of type/padding/fsid. Reading the
    # native path avoids lsof's escaping of non-printable directory names.
    class VnodePath(ctypes.Structure):
        _fields_ = [('info', ctypes.c_byte * 152), ('path', ctypes.c_char * 1024)]
    paths = (VnodePath * 2)()  # proc_vnodepathinfo: current directory, root directory
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidinfo.restype = ctypes.c_int
    count = libproc.proc_pidinfo(identity['pid'], 9, 0, ctypes.byref(paths), ctypes.sizeof(paths))
    directory = os.fsdecode(paths[0].path)
    if count != ctypes.sizeof(paths) or not directory or not Path(directory).is_dir():
        raise RuntimeError('Cannot read the original Portal working directory; Portal was left running.')
    if not identity_alive(identity):
        raise RuntimeError('Original Portal changed while capturing its launch settings; retry the upgrade.')
    return {'arguments': arguments[1:], 'cwd': directory, 'environment': environment}


identity = process_identity(int(sys.argv[1]))
if not identity or identity["executable"] != str(Path(sys.argv[2]).resolve()):
    raise RuntimeError("Portal identity changed")
print(json.dumps(launch_snapshot(identity)))
