# The installer's sandbox (#777): a Debian 13 machine as a netinst install leaves it, with the
# "SSH server" and "standard system utilities" tasks, a root password and a user `dev`, and
# nothing the install manuals add themselves (no sudo, no curl, no git, no Docker). systemd runs
# as PID 1, so the manuals' `systemctl` commands and the Docker Engine they install work as on a
# virtual machine. Built and run by scripts/install-env/cli.ts; see scripts/README.md
# ("Installer sandbox").
FROM debian:trixie

ENV container=docker LANG=C.UTF-8

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server \
      ca-certificates wget nano less procps psmisc iproute2 iputils-ping \
      bash-completion file bzip2 xz-utils lsof man-db netcat-openbsd \
      cron logrotate apt-utils whiptail \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/bash dev \
 && systemctl mask \
      sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount \
      systemd-modules-load.service getty@tty1.service console-getty.service \
 && systemctl enable ssh.service \
 && rm -f /usr/sbin/policy-rc.d /etc/apt/apt.conf.d/docker-* /etc/dpkg/dpkg.cfg.d/docker-*
# The last line drops the base image's container tweaks, which a real install does not have:
# policy-rc.d stops every package's service from starting when it is installed (the Docker
# Engine of the manual among them), and the apt and dpkg settings drop indexes and translations.

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
