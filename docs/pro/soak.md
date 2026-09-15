# Acceptance 6.5: the hour of busy output

Run once, on 2026-09-16, on the Linux dev box (node v24, herdr 0.9.0, X on
`:1`), by `scripts/soak-bench.mjs`: 20 busy tasks spread over 4 herdr
workspaces in one named session, 78 keyboard-only selection cycles (cursor with
`j/k`, promote with `Enter`, so panes mount and unmount the way a human's do),
and RSS sampled per process every 20s out of `/proc`. 178 samples over 59.9
minutes. The raw samples stay in `/tmp/cw-soak-rss.jsonl`; they are not
committed, and the report verb recomputes everything below from them.

## The numbers

| Kind | Peak | Per-10-min floor..ceiling (MB) | Reading |
|------|------|-------------------------------|---------|
| total, our processes | 1390 | 1258..1356, 1306..1364, 1333..1370, 1366..1388, 1315..1390, 1332..1369 | bounded sawtooth |
| renderer (widget + bench) | 480 | 400..453, 403..461, 428..463, 460..480, 406..480, 423..461 | GC sawtooth, ceiling stops at ~480 |
| main | 468 | 416..467 once, then 461..468 | one warmup step, then flat |
| gpu | 187 | 183..187 | flat |
| helper | 257 | 256..257 | flat |
| herdr server | 213 | 99..213, plateaued by minute 35 | its own scrollback ceiling, not our claim |

The report also prints linear slopes (+0.62 MB/min total, +0.45 renderer). Read
them as a phase artifact, not as drift: `first3` caught a GC trough (1295 MB)
and `last3` a rise (1368 MB), and the amplitude of one sawtooth is ~80 MB,
larger than the whole hour's difference between the two. The bucketed view is
the honest one. A leak raises the *floor*; here the floor returns to the same
baseline after every collection (renderer 400, 403, 428, 460, 406, 423) and the
ceiling stops climbing after warmup.

| Behaviour over the hour | Result |
|-------------------------|--------|
| selection cycles | 78, visiting 21 distinct tasks |
| panes mounted per sample | 1 - only the selected task's, by design |
| bridge phases seen | `live/true` only |
| samples with dropped frames | 0 of 178 |
| WebGL canvases per sample | 3, stable |

## What this does and does not prove

It proves the MVP's memory claim on one machine for one hour: nothing grows
without bound while twenty agents print at once and the selection walks the
tree. It does not prove the absence of a slow leak. A leak under ~1 MB/min
hides inside the sawtooth amplitude, which is exactly why the per-bucket floors
are the tripwire to look at on any future run - and why the harness keeps the
samples instead of only the verdict.

macOS has never run this; see the handoff's gap list.
