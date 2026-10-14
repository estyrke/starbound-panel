# A qemu-i386 user-mode emulator with one patch (robust.py): set_robust_list /
# get_robust_list are remembered instead of returning ENOSYS. 32-bit steamcmd
# aborts with "futex robust_list not initialized by pthreads" on stock qemu.
# The image registers itself as a binfmt_misc handler for 32-bit x86 ELF
# binaries when run privileged (see README, "pnpm local:binfmt").
FROM ubuntu:24.04 AS build
ARG QEMU_VERSION=10.2.3
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    curl xz-utils build-essential ninja-build python3 python3-venv pkg-config \
    libglib2.0-dev libpcre2-dev zlib1g-dev flex bison perl
RUN curl -fsSL https://download.qemu.org/qemu-${QEMU_VERSION}.tar.xz | tar -xJ -C /opt
COPY robust.py /robust.py
RUN python3 /robust.py /opt/qemu-${QEMU_VERSION}/linux-user/syscall.c
WORKDIR /opt/qemu-${QEMU_VERSION}/build
RUN ../configure --target-list=i386-linux-user --static --disable-docs --disable-tools \
 && make -j"$(nproc)" qemu-i386 \
 && cp qemu-i386 /qemu-i386

FROM alpine:3.20
COPY --from=build /qemu-i386 /usr/local/bin/qemu-i386-robust
COPY register.sh /register.sh
ENTRYPOINT ["/bin/sh", "/register.sh"]
