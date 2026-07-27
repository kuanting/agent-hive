# Yield-prediction project — working notes

Last updated 2026-07-26.

## Where things stand
- Current model: gradient-boosted trees over 14 process features.
- Validation accuracy: **0.912** with the new stratified 80/10/10 split
  (was 0.87 with the old random split). Wei re-ran this and pushed the notebook.
- Inference runs on-device on the edge gateway in ~40 ms.

## Changed since last week
- Switched to a stratified split, which closed most of the train/val gap.
- Added two sensor-drift features; small but consistent gain.

## Blockers
- Waiting on the new BME680 sensors (quote #Q-5582) before we can collect the
  next batch of field data. Order is within the Q3 budget.
