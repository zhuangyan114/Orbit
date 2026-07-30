# RTTB visual demo signal

The RTTB stress fixture keeps `rttb.payload[0]` as the raw sequence-byte view. It now also defines a deterministic visual signal:

```text
rttb.payload[1] = triangle(HAL_GetTick() mod 2000 ms)
```

The value spans `0..100` over a 2-second period. This does not change the 64-byte frame layout, sequence, tick, checksum, Channel 1, or scheduler path.

For a visual comparison, add both Timeline expressions:

```text
rttb.payload[0]
rttb.payload[1]
```

The updated target ELF was rebuilt at:

```text
D:\STM32\project\vet6_led\build\Debug\vet6_led.elf
```

It has not been flashed. The existing `flashBeforeDebug=false` setting remains in effect.
