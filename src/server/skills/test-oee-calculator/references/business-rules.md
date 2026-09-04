# Test OEE business rules

## Shared scope

- Apply the same inclusive date range to all three calculated components.
- Keep only `LOT_ID` values starting with `P`, `M`, `R`, `A`, `F`, or `L`.
- Calculate MT and ST independently. Aggregate each component first, then multiply the three component ratios. Do not join the two fact tables or average row-level percentages.
- Performance (Test Time) is fixed at `1`.

## MT/ST

Use `oee_availability.step` for Availability and `oee_dut_utilization.step_id` for DUT-On and Yield, in this order:

1. first character `5` → MT
2. first two characters `95` → MT
3. first character `7` → ST
4. first two characters `97` → ST
5. platform in `SHRack-U PCIe Gen 4`, `T5851`, `T5851-16G`, or `T5851-32G` → ST
6. otherwise unclassified and excluded

The canonical implementation contains the current machine IDs for the platform fallback.

## Machine_Running

Apply these conditions in order. Anything not matched is `Machine_Running`.

- `Assistance` with a non-`None` lot → `Assistance`; with lot `None` → `IDLE`.
- `Conversion` → `Conversion`.
- `HangUp` with a non-`None` lot → `HangUp`; with lot `None` → `IDLE`.
- `PM` → `PM`.
- `Handler_Flush` → `Handler_Flush`.
- `IDLE_NoWIP` → `IDLE_NoWIP`.
- `IDLE_WaitARV` → `IDLE_WaitARV`.
- `IDLE` → `IDLE`.
- `IDLE_NoWIP(NoTask)` and `IDLE_NoTask(xCurrentLot)` → `IDLE_NoWIP`.
- The named `IDLE_NoTask(...)` variants and every other value starting with `IDLE_NoTask(` except `IDLE_NoTask(xCurrentLot)` → `IDLE_NoTask`.
- `HANDLER_PAUSE(Golden)`, `Handler_Executing(Golden)`, `Loader_Unload(Golden)`, `Machine_Initialize(Golden)`, `Temp_Down(Golden)`, `Temp_Up(Golden)`, and `Test(Golden)` → `Golden_run_time`.
- `Not_Defined` → `Not_Defined`.
- `Temp_Up(Normal Retest)` with lot `None` → `Other`.
- Everything else → `Machine_Running`. This intentionally includes `Retest(Golden)`, `RMS_Initialize(Golden)`, and states containing `Golden Retest`.

Only `time_span` whose derived state is `Machine_Running` contributes to running seconds.

## Formulas

For each MT/ST kind:

```text
machine set = every distinct oee_availability.tool_name in the full database
              that has an eligible lot and classifies into the kind

calendar days = every natural day in the selected closed interval

Availability = SUM(Machine_Running time_span in range and kind)
               / (machine count × calendar days × 86400)

DUT-On = SUM(IN_QTY in range and kind) / SUM(DUT_NUM in range and kind)

Yield = SUM(OUT_QTY in range and kind) / SUM(IN_QTY in range and kind)

Test OEE = Availability × DUT-On × 1 × Yield
```

Yield includes all `test_stage` values, including `1st`, `Rescreen`, and `2ndRescreen`. Do not cap ratios or silently repair source values.
