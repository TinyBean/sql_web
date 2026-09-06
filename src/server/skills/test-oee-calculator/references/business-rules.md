# Test OEE 业务规则

## 固定关键规则

以下规则由纯工具和 SQL 表达式生成器统一实现。除非用户明确要求修改这些规则，否则不要手工重新编写。

### 有效 LOT

只保留首字符为 `P`、`M`、`R`、`A`、`F` 或 `L` 的 `LOT_ID`。

### MT/ST

Availability 使用 `oee_availability.step` 和 `oee_availability.tool_name`；DUT-On 和 Yield 使用 `oee_dut_utilization.step_id` 和 `oee_dut_utilization.machine_id`。按以下顺序判断：

1. 首字符为 `5` → MT
2. 前两个字符为 `95` → MT
3. 首字符为 `7` → ST
4. 前两个字符为 `97` → ST
5. 机台配置的平台为 `SHRack-U PCIe Gen 4`、`T5851`、`T5851-16G` 或 `T5851-32G` → ST
6. 其他情况归为未分类

平台回退规则使用的当前机台 ID 由标准实现维护。

### Machine_Running

按以下顺序应用条件。所有未匹配项均归为 `Machine_Running`。

- `Assistance` 且批次不是 `None` → `Assistance`；批次为 `None` → `IDLE`。
- `Conversion` → `Conversion`。
- `HangUp` 且批次不是 `None` → `HangUp`；批次为 `None` → `IDLE`。
- `PM` → `PM`。
- `Handler_Flush` → `Handler_Flush`。
- `IDLE_NoWIP` → `IDLE_NoWIP`。
- `IDLE_WaitARV` → `IDLE_WaitARV`。
- `IDLE` → `IDLE`。
- `IDLE_NoWIP(NoTask)` 和 `IDLE_NoTask(xCurrentLot)` → `IDLE_NoWIP`。
- 已明确列出的 `IDLE_NoTask(...)` 变体，以及除 `IDLE_NoTask(xCurrentLot)` 外所有以 `IDLE_NoTask(` 开头的值 → `IDLE_NoTask`。
- `HANDLER_PAUSE(Golden)`、`Handler_Executing(Golden)`、`Loader_Unload(Golden)`、`Machine_Initialize(Golden)`、`Temp_Down(Golden)`、`Temp_Up(Golden)` 和 `Test(Golden)` → `Golden_run_time`。
- `Not_Defined` → `Not_Defined`。
- `Temp_Up(Normal Retest)` 且批次为 `None` → `Other`。
- 其他所有情况 → `Machine_Running`。这里有意包含 `Retest(Golden)`、`RMS_Initialize(Golden)` 以及含有 `Golden Retest` 的状态。

只有派生状态为 `Machine_Running` 的 `time_span` 才计入默认口径的运行秒数。

## 默认计算口径

以下内容是没有临时口径时使用的基准。用户可以修改日期范围、数据范围、聚合方式、组成项或公式。

- 三个组成项使用相同的闭区间日期范围。
- MT 和 ST 分别聚合；先计算各组成项比率，再相乘。不要连接两张事实表，也不要平均行级百分比。
- 性能（测试时间）固定为 `1`。
- Yield 包含所有 `test_stage`，包括 `1st`、`Rescreen` 和 `2ndRescreen`。
- 不限制比率上限，也不静默修正源数据值。

对每一种 MT/ST 类型：

```text
机台集合 = 整个数据库中具有有效批次且被归入当前类型的所有不重复的
           oee_availability.tool_name

自然日数 = 所选闭区间内的全部自然日

Availability = SUM(范围和类型内 Machine_Running 状态的 time_span)
               / (机台数量 × 自然日数 × 86400)

DUT-On = SUM(范围和类型内的 IN_QTY) / SUM(范围和类型内的 DUT_NUM)

Yield = SUM(范围和类型内的 OUT_QTY) / SUM(范围和类型内的 IN_QTY)

Test OEE = Availability × DUT-On × 1 × Yield
```

## 临时口径

如果用户指定的口径与默认值不同，查询和计算必须按用户口径组合，同时明确列出差异。若用户修改的是固定关键规则，则不要调用受影响的固定工具；改用用户提供的规则执行 SQL，并说明该结果没有采用对应的标准规则工具。
