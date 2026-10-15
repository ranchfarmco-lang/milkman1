#!/bin/sh
# NOVA OS initramfs builder.
#
# Builds the small cpio archive the kernel is handed at boot. Its only job is to
# find the NOVA root filesystem, mount it, and hand over to the real init. The
# init here is written out by this script and is deliberately tiny: an initramfs
# that does too much is an initramfs that fails on unfamiliar hardware.
#
# Run on a Linux build host with `cpio`, `busybox` and `gzip`:
#
#   sh os/build/initramfs.sh
#
# It writes os/build/out/nova-initramfs.cpio.gz.
#
# This step needs a Linux build host. The container this repository is edited in
# has no toolchain and a small disk budget, so this script is real but is run on
# the build machine or CI runner described in os/build/README.md.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT="$ROOT/os/build/out"
STAGE="$OUT/initramfs"

BUSYBOX_FLAGS=${BUSYBOX_FLAGS:-}

if [ ! -f "$ROOT/os/build/kernel.config" ]; then
  echo "kernel.config is missing; run this from the repository." >&2
  exit 1
fi

for tool in busybox cpio gzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "This needs $tool on the build host." >&2
    exit 1
  fi
done

echo "==> staging the initramfs under $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/dev" "$STAGE/proc" "$STAGE/sys" "$STAGE/run" "$STAGE/mnt/root" "$STAGE/etc"

if ! cp -a "$(command -v busybox)" "$STAGE/bin/busybox" 2>/dev/null; then
  cp "$(command -v busybox)" "$STAGE/bin/busybox"
fi
# Install every applet busbox can provide; the init below uses a handful of them.
"$STAGE/bin/busybox" --install -s "$STAGE/bin"

cat > "$STAGE/init" <<'INIT'
#!/bin/busybox sh
# NOVA OS initramfs init. Mounts the root filesystem and switches to it.
/bin/busybox sh -c "mount -t proc none /proc; mount -t sysfs none /sys; mount -t devtmpfs none /dev" 2>/dev/null || true

ROOTDEV=$(/bin/busybox sh -c "for d in /dev/vda2 /dev/sda2 /dev/nvme0n1p2 /dev/mmcblk0p2; do [ -b \$d ] && echo \$d && break; done")

if [ -z "$ROOTDEV" ]; then
  /bin/busybox echo "NOVA: no root device found; dropping to a shell."
  exec /bin/busybox sh
fi

/bin/busybox mkdir -p /mnt/root
if ! /bin/busybox mount -t btrfs -o rw "$ROOTDEV" /mnt/root; then
  /bin/busybox mount -t ext4 -o rw "$ROOTDEV" /mnt/root
fi

/bin/busybox mkdir -p /mnt/root/proc /mnt/root/sys /mnt/root/dev /mnt/root/run
/bin/busybox mount -t proc none /mnt/root/proc
/bin/busybox mount -t sysfs none /mnt/root/sys
/bin/busybox mount -t devtmpfs none /mnt/root/dev

/bin/busybox echo "NOVA: handing over to $ROOTDEV"
exec /bin/busybox switch_root /mnt/root /sbin/init
INIT
chmod +x "$STAGE/init"

echo "==> packing"
( cd "$STAGE" && find . -print0 | cpio --null -o -H newc --owner 0:0 | gzip -9 ) > "$OUT/nova-initramfs.cpio.gz"

echo "wrote $OUT/nova-initramfs.cpio.gz ($(du -h "$OUT/nova-initramfs.cpio.gz" | cut -f1))"
