# NOVA OS tests

## Running them

```sh
bun os/tests/run.ts
```

The runner points `NOVA_ROOT` at a fresh temporary directory, so a run never
touches a real installation. It exits non-zero if any case fails and writes a
machine-readable report to `$NOVA_ROOT/state/test-report.json`.

The names of the cases are the ones `os/requirements.ts` references. The audit
in `os/diag/audit.ts` checks that each referenced name actually appears in
`run.ts`, so a requirement cannot claim a test that does not exist.

## What is covered here

Sixty cases across the supervisor, the configuration and bus, the network
manager, the VPN planner and parsers, the firewall ruleset generator and
validator, the web service and its router, the browser transport and parser, the
application runtime, the AI runtime, agents and the change pipeline, snapshots,
the communications engine's STUN/SDP/ICE and call state machine, the package
manager, the update status, and the audit itself.

## What cannot run in a container

The acceptance runs that need real hardware are listed here rather than being
claimed. They need a machine with:

- a bootable NOVA image (built per `os/build/README.md`);
- `CAP_NET_ADMIN` for applying the firewall ruleset and bringing a WireGuard
  tunnel up;
- a display for the browser and communications user interfaces;
- capture hardware and media codecs for a real call;
- a carrier (`NOVA_PSTN_CARRIER`) for a telephone leg;
- a public address or a port forward for direct inbound remote access.

On such a machine the same components run; the container simply cannot perform
the privileged or hardware steps, and reports that rather than pretending.
