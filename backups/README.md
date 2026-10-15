# A snapshot of the hub's database

`convex-snapshot-neat-crane-777-2026-10-11.zip` is everything the hub's Convex
deployment held on 11 October 2026: the family, its 5 users and 8 devices, the
10 messages, the calendar event, 388 files, the AI threads and briefings, the
call records and the security log — 1035 rows in all.

It was taken straight from the deployment (`bunx convex export`) at a moment
when that deployment had been switched off for exceeding a usage limit, so the
app could not read it but the export could. It is the family's data, including
session tokens: it is ignored by git (`.gitignore` has `*.zip`) and it should
not be shared.

To put it into a deployment — your own, or a replacement for the disabled one —
point the CLI at that deployment and import it:

```bash
bunx convex import --replace-all backups/convex-snapshot-neat-crane-777-2026-10-11.zip
```

`--replace-all` clears whatever the new deployment holds first, which is what
you want for a fresh, empty backend. For a backend of your own **on this
machine**, do not run that by hand: `bun run restore -- <this file>` aims the
same import at that backend by name, with no account and no flags, and refuses to
run when the backend is not answering — which is what keeps `--replace-all` from
being aimed at the wrong deployment. See `self-hosting/README.md`. Give the new deployment its signing keys
and family password afterwards (`bun scripts/generate-auth-keys.mjs`,
`bunx convex env set HUB_PASSWORD …`) so the accounts carried over can sign in
again — see `DEPLOY.md`, steps 1 and 3.
