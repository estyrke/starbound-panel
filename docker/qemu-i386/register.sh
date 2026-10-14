#!/bin/sh
# Registers the patched qemu-i386 as the binfmt_misc handler for 32-bit x86
# ELF binaries. Needs --privileged. The kernel runs the most recently registered
# matching handler first, so this takes priority over OrbStack's built-in
# (protected, unremovable) qemu-i386 entry. The F flag loads the emulator now,
# so it works inside any container afterwards. Lost when the Docker VM restarts.
set -eu
NAME=qemu-i386-robust
BINFMT=/proc/sys/fs/binfmt_misc

mountpoint -q "$BINFMT" || mount -t binfmt_misc none "$BINFMT"
if [ -e "$BINFMT/$NAME" ]; then
  echo "$NAME already registered"
  exit 0
fi
# name:type:offset:magic:mask:interpreter:flags (ELF32, EM_386)
printf '%s' ":$NAME:M::\\x7f\\x45\\x4c\\x46\\x01\\x01\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x02\\x00\\x03\\x00:\\xff\\xff\\xff\\xff\\xff\\xfe\\xfe\\xfc\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\xfe\\xff\\xff\\xff:/usr/local/bin/qemu-i386-robust:OCF" > "$BINFMT/register"
echo "registered $NAME"
