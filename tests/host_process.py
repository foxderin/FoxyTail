"""Darwin-only kernel reads for relocated Android shell lifecycle fixtures."""
import ctypes
import os
import struct
import sys
import time


class BSDInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid', 'ruid', 'rgid', 'svuid', 'svgid', 'reserved')]
    _fields_ += [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in ('nfiles', 'pgid', 'jobc', 'tty', 'tpgid', 'nice')]
    _fields_ += [('start_seconds', ctypes.c_uint64), ('start_microseconds', ctypes.c_uint64)]


lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]


def process_info(pid):
    info = BSDInfo()
    if lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
        raise ProcessLookupError(pid)
    if info.pid != pid or info.status == 5 or info.flags & 4:
        raise ProcessLookupError(pid)
    return info


def main():
    action = sys.argv[1]
    if action == 'self':
        print(process_info(os.getppid()).ppid)
    elif action == 'monotonic':
        print(int(time.monotonic()))
    elif action == 'stamp':
        info = process_info(int(sys.argv[2]))
        print(info.start_seconds * 1000000 + info.start_microseconds)
    elif action == 'children':
        parent = int(sys.argv[2])
        size = lib.proc_listpids(1, 0, None, 0)
        pids = (ctypes.c_int * (size // ctypes.sizeof(ctypes.c_int) + 128))()
        count = lib.proc_listpids(1, 0, pids, ctypes.sizeof(pids))
        if count <= 0:
            raise OSError('process enumeration failed')
        for pid in pids[:count // ctypes.sizeof(ctypes.c_int)]:
            if pid <= 0:
                continue
            try:
                info = process_info(pid)
            except ProcessLookupError:
                continue
            if info.ppid == parent:
                print(f'{pid}:{info.start_seconds * 1000000 + info.start_microseconds}')
    elif action == 'cmdline':
        system = ctypes.CDLL(None, use_errno=True)
        system.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
                                 ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
        mib = (ctypes.c_int * 3)(1, 49, int(sys.argv[2]))  # CTL_KERN/KERN_PROCARGS2
        data = ctypes.create_string_buffer(1024 * 1024)
        size = ctypes.c_size_t(len(data))
        if system.sysctl(mib, 3, data, ctypes.byref(size), None, 0) != 0:
            raise ProcessLookupError(sys.argv[2])
        raw = data.raw[:size.value]
        argc = struct.unpack_from('i', raw)[0]
        offset = raw.index(b'\0', 4) + 1
        while offset < len(raw) and raw[offset] == 0:
            offset += 1
        args = raw[offset:].split(b'\0')[:argc]
        if len(args) != argc:
            raise ValueError('incomplete process arguments')
        sys.stdout.buffer.write(b'\n'.join(arg.replace(b'\n', b'\r') for arg in args) + b'\n')
    else:
        raise ValueError(action)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError):
        sys.exit(1)
