import sys, re
p = sys.argv[1]
s = open(p).read()
old = "    case TARGET_NR_set_robust_list:\n    case TARGET_NR_get_robust_list:\n"
assert old in s
new = """    case TARGET_NR_set_robust_list:
        /* patched: remember the head; steamcmd checks it via get_robust_list */
        qemu_robust_head = arg1;
        qemu_robust_len = arg2;
        return 0;
    case TARGET_NR_get_robust_list:
        if (arg1 != 0) {
            return -TARGET_ENOSYS;
        }
        if (put_user_ual(qemu_robust_head, arg2) ||
            put_user_ual(qemu_robust_len, arg3)) {
            return -TARGET_EFAULT;
        }
        return 0;
    case 0x7fffffff: /* unreachable: keeps the original comment/ENOSYS block below */
"""
s = s.replace(old, new)
# thread-local storage declarations, placed before do_syscall1
marker = "static abi_long do_syscall1("
assert marker in s
s = s.replace(marker, "static __thread abi_ulong qemu_robust_head;\nstatic __thread abi_ulong qemu_robust_len;\n\n" + marker, 1)
open(p, "w").write(s)
