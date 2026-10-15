# Building the NOVA OS image

This directory builds the thing the rest of the repository cannot: a bootable
disk image. The userspace in `os/` is real and runs in a container; the kernel and
image are assembled here, on a Linux build host.

## Why a separate host

The editing container this repository lives in has no compiler toolchain and a
small disk budget, so it cannot build a kernel or a multi-gigabyte image. That is
a property of the environment, not of the code: nothing here is a sketch. Each
script is a working build step, and the only thing that stops it running in the
container is the missing toolchain. The requirement audit
(`os/diag/audit.ts`) reports exactly this under the `kernel` and `image`
requirements, with the reason.

## What you need

A Linux x86-64 build host (a CI runner or a VM) with:

- `make`, `gcc`, `flex`, `bison`, `bc`, `libelf-dev`, `libssl-dev`, `pahole`
- `cpio`, `busybox`, `gzip`
- `sgdisk` (gdisk), `mkfs.fat` (dosfstools), `mkfs.btrfs` (btrfs-progs)
- `losetup` with loop devices, and root (for the image assembly)
- Optionally a staged base rootfs in `BASE_ROOTFS`; otherwise a minimal busybox
  rootfs is assembled

`bun` is copied onto the image when it is present on the build host, because the
OS's own init (`/sbin/init` on the image) launches `os/main.ts` with it.

## The build, in order

```sh
# 1. Fetch and configure the Linux 6.12 series kernel.
git clone --depth 1 -b v6.12 https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git
cd linux
make defconfig
scripts/kconfig/merge_config.sh .config ../os/build/kernel.config
make -j"$(nproc)" bzImage
cp arch/x86/boot/bzImage ../os/build/out/bzImage
cd ..

# 2. Build the initramfs.
sh os/build/initramfs.sh

# 3. Assemble the bootable image.
sh os/build/build-image.sh

# 4. Package it, or write it to a device.
sh os/build/installer.sh --image os/build/out/nova-os.img --package
```

The output is `os/build/out/nova-os.img`, its SHA-256, and a manifest.

## What is on the image

- the kernel built from `os/build/kernel.config`, with WireGuard, nftables,
  btrfs, namespaces and the audio and video device nodes the OS's own
  components use;
- a minimal initramfs whose only job is to find the root and hand over;
- a GPT layout: a 512 MB EFI system partition and a btrfs root;
- the OS source tree at `/opt/nova/os`, so the running system can audit itself
  against `os/requirements.ts`;
- `/sbin/init`, which mounts the kernel filesystems, sets `NOVA_ROOT` to
  `/var/lib/nova`, and starts the userspace supervisor in `os/init`.

## Privileged helpers

Three operations need privilege that ordinary userspace does not have, and the
image gives them a helper rather than granting the whole supervisor root:

- applying the nftables ruleset (`nft --check --file` then `nft --file`);
- bringing a WireGuard interface up (`ip link add ... type wireguard`, `wg
  setconf`);
- binding ports below 1024 for the web service.

In a container these are absent, so the OS generates and validates the exact
commands and reports them as resources it cannot apply. On the image the helper
runs them and reports the result.
