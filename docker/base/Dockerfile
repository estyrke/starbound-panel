# check=skip=FromPlatformFlagConstDisallowed
# Base image for the local Hetzner emulator: Ubuntu 22.04 (amd64) with systemd
# as PID 1 and cloud-init using only the NoCloud datasource. See README.
FROM --platform=linux/amd64 ubuntu:22.04

ENV container=docker DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus cloud-init sudo ca-certificates curl iproute2 \
      iputils-ping gnupg locales tzdata lsb-release \
 && rm -rf /var/lib/apt/lists/*

# Only NoCloud, reading the seed from this directory (user-data + meta-data).
RUN rm -f /etc/cloud/cloud.cfg.d/90_dpkg.cfg \
 && printf 'datasource_list: [ NoCloud, None ]\ndatasource:\n  NoCloud:\n    seedfrom: /var/lib/cloud/seed/nocloud/\n' \
      > /etc/cloud/cloud.cfg.d/99-nocloud.cfg \
 && printf 'network:\n  config: disabled\npreserve_hostname: true\nmanage_etc_hosts: false\napt:\n  preserve_sources_list: true\n' \
      > /etc/cloud/cloud.cfg.d/98-container.cfg \
 && mkdir -p /var/lib/cloud/seed/nocloud

# Units that make no sense (or fail) inside a container.
RUN systemctl mask \
      getty.target console-getty.service getty@tty1.service \
      systemd-udevd.service systemd-udev-trigger.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-modules-load.service systemd-remount-fs.service sys-kernel-config.mount sys-kernel-debug.mount \
      systemd-resolved.service apt-daily.timer apt-daily-upgrade.timer motd-news.timer \
      unattended-upgrades.service snapd.service

# systemd halts on SIGRTMIN+3 (not SIGTERM).
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
