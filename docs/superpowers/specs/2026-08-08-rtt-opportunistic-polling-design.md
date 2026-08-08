# RTT Opportunistic Background Polling Design

Date: 2026-08-08

## Goal

Keep RTT logging usable while high-rate Timeline sampling is active, while preserving Timeline priority and keeping the configured RTT polling interval under the user's control.

## Scheduling Contract

- `orbit.rttPollIntervalMs` remains the only RTT polling interval setting.
- The interval is completion-relative: after one RTT poll completes, DAP waits at least the configured interval before submitting the next poll.
- Missed intervals are not queued, replayed, or caught up.
- At most one RTT read may be queued or in flight for a DAP session.
- `readRtt` remains `background` work with the existing `rtt-read` coalescing key and generation/abort fence.
- `control > watch > timeline > background` remains unchanged. A started owner call cannot be preempted.

## Lifecycle

- RTT starts once during launch when RTT logging is enabled.
- Starting or stopping Timeline sampling does not start, stop, reset, or abort RTT logging.
- The active Timeline flag does not suppress RTT poll scheduling.
- RTT is physically stopped only when logging is disabled or the DAP session disconnects, restarts, loses its owner, or is disposed.
- Decoder state is preserved across Timeline start and stop.
- J-Link `startRtt` and `stopRtt` are control-priority lifecycle operations. `readRtt` remains background priority.

## Poll Loop

Each poll loop iteration performs at most one start-if-needed operation and one RTT read. After the iteration settles, it schedules one timer using the current configured `rttPollIntervalMs`. The loop never uses a fixed wall-clock cadence and never creates a backlog.

An RTT read failure retains structured logging, marks RTT as not started, and retries through the same completion-relative interval. It does not immediately retry. Session stop or generation replacement cancels queued work and prevents stale bytes from being published.

## Scope

The change is limited to DAP RTT polling and J-Link RTT lifecycle priority. It does not add another target owner, change RuntimeRouter routing, change Timeline/Watch priority, introduce scheduler-wide fairness quotas, or modify native helper protocol fields.

## Tests

- Prove RTT polling continues while `dataSamplingActive` is true.
- Prove Timeline start does not call `stopRtt` and Timeline stop does not restart RTT.
- Prove the next poll is scheduled only after the previous read completes plus `rttPollIntervalMs`.
- Preserve stale-completion suppression after a real RTT stop.
- Prove J-Link `startRtt` and `stopRtt` use control priority while `readRtt` uses background priority.
- Run focused RTT, realtime sampling, scheduler, and J-Link channel tests, then typecheck, build, and the full Vitest suite.

## Acceptance

Automated tests must pass without changing existing owner or routing contracts. Real-hardware acceptance must separately confirm concurrent RTT output and Timeline sampling, compare Timeline throughput and P95/max gaps against the RTT-disabled baseline, and check RTT for overrun or missing output. Automated and mock results are not hardware acceptance.

## Rollback

Revert the DAP coexistence changes and J-Link lifecycle priority mapping. No persisted data or protocol migration is involved.
