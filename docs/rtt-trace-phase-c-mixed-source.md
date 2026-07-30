# Phase C mixed-source Timeline

The Timeline source is now `mixed` by default. The source is selected from the
expression when a Timeline is started:

- `rttb.payload[N]` is decoded from RTTB Channel 1 by the active Native DAP
  session.
- Other expressions use the existing DAP fast-sampling path.

Both paths share the same DAP session, `NativeScheduler`, and physical J-Link
owner. No extension-host fallback or second J-Link connection is created while
the active `ozone` session exists.

For the `vet6_led` demonstration, use the launch configuration
`Ozone: RTTB vs DAP Timeline comparison (flash)`. It flashes the selected ELF
before connecting. The similarly named `no flash` configuration is provided for
visual-only reruns.

Suggested Timeline expressions:

```text
rttb.payload[1]
rtt_bench_demo_value
```

Both expressions represent the same firmware demo triangle value. The first is
transported in RTTB; the second is read through the original DAP fast-sampling
path. The target ELF must be rebuilt and flashed before this matched comparison
is expected on hardware.
