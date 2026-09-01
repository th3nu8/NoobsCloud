#!/usr/bin/env bash
# Run this INSIDE the Docker-host VM on each Proxmox worker node (NOT the Proxmox host itself).
# Installs the binder_linux + ashmem_linux kernel modules Redroid requires for Android IPC.
set -euo pipefail

echo "== Checking if binder is already available (modern kernels often ship it built-in) =="
if modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null; then
  echo "binder_linux loaded from the kernel's existing modules — no build needed."
  modprobe ashmem_linux 2>/dev/null || echo "NOTE: ashmem_linux not available/needed on this kernel — recent Android userspace mostly uses memfd instead, this is usually fine."
  cat <<EOF > /etc/modules-load.d/redroid.conf
binder_linux
EOF
  cat <<EOF > /etc/modprobe.d/redroid.conf
options binder_linux devices=binder,hwbinder,vndbinder
EOF
  echo "== Verifying =="
  ls -l /dev/binderfs 2>/dev/null || ls -l /dev/binder* 2>/dev/null || echo "WARNING: /dev/binder* not found — check dmesg"
  exit 0
fi

echo "binder_linux not available out of the box — building from source."
echo "== Installing build deps =="
apt-get update
apt-get install -y git build-essential linux-headers-$(uname -r) dkms

echo "== Cloning anbox-modules (provides binder_linux / ashmem_linux DKMS sources) =="
cd /usr/src
if [ ! -d anbox-modules-src ]; then
  git clone https://github.com/choff/anbox-modules.git anbox-modules-src
fi

# The repo has TWO separate DKMS modules, each in its own subdir with its
# own dkms.conf — not one at the repo root. Register each separately.
for mod in binder ashmem; do
  ver="1.0"
  target="/usr/src/anbox-${mod}-${ver}"
  if [ ! -d "$target" ]; then
    cp -r "/usr/src/anbox-modules-src/${mod}" "$target"
  fi
  echo "== Registering anbox-${mod}/${ver} with DKMS =="
  dkms add -m "anbox-${mod}" -v "$ver" || true
  dkms build -m "anbox-${mod}" -v "$ver"
  dkms install -m "anbox-${mod}" -v "$ver"
done

echo "== Loading modules =="
modprobe binder_linux devices="binder,hwbinder,vndbinder"
modprobe ashmem_linux

echo "== Persisting across reboots =="
cat <<EOF > /etc/modules-load.d/redroid.conf
binder_linux
ashmem_linux
EOF

cat <<EOF > /etc/modprobe.d/redroid.conf
options binder_linux devices=binder,hwbinder,vndbinder
EOF

echo "== Verifying =="
ls -l /dev/binderfs 2>/dev/null || ls -l /dev/binder* 2>/dev/null || echo "WARNING: /dev/binder* not found — check dmesg for module load errors"

echo "Done. Reboot the VM once to confirm modules persist, then re-run the verify step."
