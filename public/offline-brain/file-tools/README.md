# file-tools/

Filesystem operations: read/write/edit, traversal, search, archive, transfer.
Installed by `../scripts/install-file-tools.sh`.

- **Core**: `coreutils`, `findutils`, `tree`, `file`, `stat`.
- **Search**: `ripgrep`, `fd`, `fzf`, `sd`, `moreutils`.
- **Archives**: `tar`, `zip`/`unzip`, `zstd`, `xz`, `p7zip`.
- **Transfer**: `curl`, `wget`, `rsync`, `rclone`.
- **Watching**: `inotify-tools`.

Freebuff's file tools: `../source/freebuff/sdk/src/tools/read-files.ts`,
`change-file.ts`, `apply-patch.ts`, `glob.ts`, `list-directory.ts`, and the
interface abstraction in
`../source/freebuff/sdk/src/tools/sponsored-rooted-filesystem.ts`.
