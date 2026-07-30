# Phase C Timeline RTT quota recheck (2026-07-30)

The Timeline scheduler keeps the existing request-size reservation semantics used by RTT/Legacy and now defaults its Timeline budget to `512 KiB/s`. This covers a `readSize=4096` request at the DAP 10 ms polling floor without creating a false quota error.

Standard DAP smoke sequence:

```text
initialize
launch (Native, flashBeforeDebug=false, RTT Timeline Channel 1, readSize=4096)
configurationDone
dataSamplingStart(source=rtt, rttb.payload[0])
wait 2.2 s (target halted)
getRttStreamMetrics
dataSamplingStop
disconnect
```

Result:

- Native owner connected and exited cleanly; no second J-Link owner.
- `decodedFrames=63`, `bytesRead=4032`.
- `decodeErrors=0`, `checksumErrors=0`, `truncatedFrames=0`, `sequenceGaps=0`.
- `errorCount=0`, `droppedBytes=0`, `droppedChunks=0`.
- `readCalls=142`, `emptyReads=141`; no quota error while halted.
- No flash operation and no target firmware change.

## Reset timestamp rebase

`HAL_GetTick()` is target uptime and returns to a low value after reset. `RttTimelineConsumer` now rebases the next segment when necessary so Timeline timestamps remain monotonic. The raw RTTB `tick` field and intra-run deltas remain unchanged; only the Timeline presentation timestamp receives the offset.

Real DAP reset smoke after rebuilding `dist/debugadapter.js`:

- before reset: 1,260 Timeline points, last timestamp `910725`
- after reset: 1,008 additional points, first timestamp `910828`
- timestamps remained monotonic and a post-reset point carried `startsNewSegment=true`
- metrics: `decodedFrames=2331`, `decodeErrors/checksumErrors/truncatedFrames=0`, `errorCount=0`, `droppedBytes=0`
- Native helper exited cleanly; no flash and no second owner

## 10-second running soak

Using the same standard DAP launch with `Continue → dataSamplingStart(source=rtt)`, then a bounded 10-second run:

- `sampleBatches=110`, `samplePoints=6915`
- `bytesRead=437056`, `readCalls=398`, `emptyReads=289`
- throughput approximately `42.7 KiB/s`, read calls approximately `39.9/s`
- `decodedFrames=6829`, `decodeErrors=0`, `checksumErrors=0`, `truncatedFrames=0`
- `errorCount=0`, `droppedBytes=0`, `droppedChunks=0`
- `maxQueueDepthBytes=4096`, `maxDelayMs=1`
- `sequenceGaps=108`, `missingFrames=7282492`; these remain target-side `NO_BLOCK_SKIP` loss evidence
- average/max decode latency approximately `0.068/1 ms`

## Control-priority regression

The same Native DAP session ran `Continue → RTT Timeline → Pause → Step Over → Continue`:

- `Pause` and native `Step Over` both succeeded; the step completed in about 16 ms.
- Timeline emitted `37` batches / `2432` points across the control handoff.
- `decodedFrames=2432`, `decodeErrors=0`, `checksumErrors=0`, `truncatedFrames=0`.
- `errorCount=0`, `droppedBytes=0`, `droppedChunks=0`.
- Native helper exited cleanly; no second owner and no flash operation.

## RTT/DAP source switch regression

Within one active Native DAP session, RTT Timeline was started and stopped, then the existing DAP Timeline was started for `rtt_bench_attempted_frames`:

- RTT source planned and emitted `63` points.
- DAP source planned successfully with a DWARF-resolved `uint32_t` address and emitted `150` points.
- RTT metrics after the switch: `decodedFrames=63`, all decode/checksum/truncated/transport/drop counters were zero.
- The DAP source continued through `Continue` and stopped cleanly; no extension-host fallback was used.
