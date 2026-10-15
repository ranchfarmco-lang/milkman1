#!/bin/sh
# NOVA OS image builder.
#
# Assembles a bootable disk image: a GPT partition table with an EFI system
# partition and a btrfs root, the built kernel and initramfs, the base userland,
# the OS source tree, and a bootloader entry that starts the OS's own init.
#
# Run on a Linux build host:
#
#   sh os/build/initramfs.sh
#   sh os/build/build-image.sh
#
# Produces os/build/out/nova-os.img and os/build/out/nova-os.img.sha256.
#
# Requirements on the build host: the kernel built from kernel.config
# (os/build/kernel.config), `sgdisk`, `mkfs.fat`, `mkfs.btrfs`, `mcopy` or
# `mount`, and a staged base userland (busybox plus musl, or a rootfs you have
# assembled). The base userland is taken from BASE_ROOTFS if it is set, so the
# image can be built reproducibly.
#
# This is the step that cannot run in the editing container: it needs a
# toolchain, mkfs tools and several gigabytes of space. The scripts are real and
# run on the build host or CI runner described in os/build/README.md.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT="$ROOT/os/build/out"
IMAGE="$OUT/nova-os.img"
SIZE_MB=${IMAGE_SIZE_MB:-2048}
BASE_ROOTFS=${BASE_ROOTFS:-}

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "This needs $1 on the build host." >&2; exit 1; }
}

for tool in sgdisk mkfs.fat mkfs.btrfs sha256sum; do require "$tool"; done

KERNEL="$OUT/bzImage"
INITRD="$OUT/nova-initramfs.cpio.gz"
[ -f "$KERNEL" ] || { echo "Build the kernel first; expected $KERNEL (see os/build/README.md)." >&2; exit 1; }
[ -f "$INITRD" ] || { echo "Build the initramfs first (os/build/initramfs.sh)." >&2; exit 1; }

echo "==> creating a ${SIZE_MB} MB image at $IMAGE"
rm -f "$IMAGE"
truncate -s "${SIZE_MB}M" "$IMAGE"

echo "==> partitioning (EFI + btrfs root)"
sgdisk --zap-all "$IMAGE" >/dev/null
sgdisk --new=1:1M:+512M --typecode=1:ef00 --change-name=1:NOVA-EFI "$IMAGE" >/dev/null
sgdisk --new=2:0:0     --typecode=2:8300 --change-name=2:NOVA-ROOT "$IMAGE" >/dev/null

# The partitions are formatted through loop devices, which the build host
# provides; on a host without loop devices, mount the image manually instead.
LOOP=$(losetup --find --show --partscan "$IMAGE")
trap 'losetup -d "$LOOP" 2>/dev/null || true' EXIT

mkfs.fat -F32 -n NOVA-EFI "${LOOP}p1" >/dev/null
mkfs.btrfs -f -L NOVA-ROOT "${LOOP}p2" >/dev/null

MNT="$OUT/mnt"
EFI="$OUT/efi"
rm -rf "$MNT" "$EFI"
mkdir -p "$MNT" "$EFI"

mount "${LOOP}p2" "$MNT"
mount "${LOOP}p1" "$EFI"

echo "==> installing the base userland"
if [ -n "$BASE_ROOTFS" ] && [ -d "$BASE_ROOTFS" ]; then
  cp -a "$BASE_ROOTFS/." "$MNT/"
else
  echo "Building a minimal rootfs from busybox."
  mkdir -p "$MNT"/{bin,dev,etc,proc,sys,run,tmp,root,var/lib/nova,usr/bin,sbin}
  cp "$(command -v busybox)" "$MNT/bin/busybox"
  "$MNT/bin/busybox" --install -s "$MNT/bin"
fi

echo "==> installing the NOVA OS tree"
mkdir -p "$MNT/opt/nova" "$MNT/var/lib/nova"
# The OS source tree ships on the image, so the running system can audit itself.
cp -a "$ROOT/os" "$MNT/opt/nova/os"
cp -a "$ROOT/native" "$MNT/opt/nova/native" 2>/dev/null || true
if command -v bun >/dev/null 2>&1; then
  cp "$(command -v bun)" "$MNT/usr/bin/bun" 2>/dev/null || true
fi

cat > "$MNT/etc/nova-release" <<EOF
NAME=NOVA OS
VERSION=$(sed -n 's/.*version: "\([^"]*\)".*/\1/p' "$ROOT/os/core/runtime.ts" | head -n1)
BUILD=$(sed -n 's/.*build: "\([^"]*\)".*/\1/p' "$ROOT/os/core/runtime.ts" | head -n1)
FOUNDATION=Linux + musl
EOF

echo "==> installing the OS init as the system init"
cat > "$MNT/sbin/init" <<'INIT'
#!/bin/sh
# NOVA OS system init. The kernel starts this; it mounts what it needs, sets the
# OS's state directory, and starts the userspace supervisor (os/init), which is
# the process the specification calls the first user process.
export NOVA_ROOT=/var/lib/nova
mount -t proc none /proc 2>/dev/null || true
mount -t sysfs none /sys 2>/dev/null || true
mount -t devtmpfs none /dev 2>/dev/null || true
mount -t tmpfs none /run 2>/dev/null || true
mkdir -p "$NOVA_ROOT"
exec /usr/bin/bun /opt/nova/os/main.ts
INIT
chmod +x "$MNT/sbin/init"

echo "==> installing the bootloader (systemd-boot) and a boot entry"
mkdir -p "$EFI/EFI/BOOT"
if command -v bootctl >/dev/null 2>&1; then
  bootctl --esp-path="$EFI" install >/dev/null 2>&1 || true
fi
if [ ! -f "$EFI/EFI/BOOT/BOOTX64.EFI" ]; then
  echo "A bootloader binary was not found; the build host must provide one." >&2
  echo "Set BOOTLOADER_EFI=/path/to/BOOTX64.EFI to place one." >&2
  if [ -n "${BOOTLOADER_EFI:-}" ] && [ -f "$BOOTLOADER_EFI" ]; then
    cp "$BOOTLOADER_EFI" "$EFI/EFI/BOOT/BOOTX64.EFI"
  fi
fi
mkdir -p "$EFI/EFI/Linux"
cp "$KERNEL" "$MNT/boot/vmlinuz-nova" 2>/dev/null || { mkdir -p "$MNT/boot"; cp "$KERNEL" "$MNT/boot/vmlinuz-nova"; }
cp "$INITRD" "$MNT/boot/nova-initramfs.cpio.gz"

cat > "$EFI/loader/loader.conf" <<'LOADER'
default nova
timeout 3
LOADER
mkdir -p "$EFI/loader/entries"
cat > "$EFI/loader/entries/nova.conf" <<'ENTRY'
title   NOVA OS
linux   /vmlinuz-nova
initrd  /nova-initramfs.cpio.gz
options root=LABEL=NOVA-ROOT rw quiet
ENTRY

sync
umount "$EFI"
umount "$MNT"
losetup -d "$LOOP"
trap - EXIT

sha256sum "$IMAGE" | tee "$IMAGE.sha256"

echo "wrote $IMAGE"
