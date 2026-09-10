# Test OEE 业务规则

## 固定关键规则

以下规则由纯工具和 SQL 生成器统一实现。除非用户明确要求修改，否则不要手工重写。

### 有效 LOT

只保留首字符为 `P`、`M`、`R`、`A`、`F` 或 `L` 的 `LOT_ID`。其他批次（包括 `None`）不参与默认计算。

### 平台匹配与 PCIe 排除

机台平台来自《MT 不同平台的数据.xlsx》的 `Machine` → `PLATFORM` 映射，共 208 台机台且没有重复 Machine。

平台名称包含 `PCIe` 的机台一律不参与 Test OEE，且该排除优先于 MT/ST 判定。当前被排除的是 `TSPH001` 至 `TSPH013`：其中 9 台是 `SHRack-U PCIe Gen 4`，4 台是 `SHRack-U PCIe Gen 5`。

平台表中没有出现的机台不因“未知平台”而自动排除；仍可由 STEP 判为 MT/ST。回答时若发现未配置机台，应单独报告，不能擅自推断其平台。

### MT/ST

Availability 使用 `oee_availability.step` 和 `oee_availability.tool_name`；DUT-On、Test Time 和 Yield 使用 `oee_dut_utilization.step_id` 和 `oee_dut_utilization.machine_id`。先应用 PCIe 排除，再按以下顺序判定：

1. STEP 首字符为 `5` → MT。
2. STEP 前两个字符为 `95` → MT。
3. STEP 首字符为 `7` → ST。
4. STEP 前两个字符为 `97` → ST。
5. Excel 中机台平台为 `SHRack-U PCIe Gen 4`、`T5851`、`T5851-16G` 或 `T5851-32G` → ST。
6. 其他情况归为未分类。

第 5 项保留原始分类公式；由于 PCIe 排除优先，`SHRack-U PCIe Gen 4` 机台虽可被分类工具标为 ST，但不会进入 OEE 计算。平台回退和 PCIe 排除使用的机台 ID 由标准实现维护。

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

只有派生状态为 `Machine_Running` 的 `time_span` 才计入运行秒数。

## 默认计算口径

### 日期和粒度

- `date` 是业务日标签：标签日当天 08:30 至次日 08:30 算作一个业务日。不要再根据 `start_time` 或 `end_time` 将记录二次移日。
- 用户选择的日期是业务日闭区间；四个组成项必须使用同一范围。
- 两张事实表先分别计算到 `业务日 + MT/ST` 粒度，再以 Availability 日结果为主表，按这两个键左连接 DUT 日结果。
- DUT 中没有对应 Availability 日类型的结果不进入默认 OEE；Availability 没有匹配 DUT 或任一组成项无法计算时，该日该类型 OEE 为 `NULL`。

### 单日组成项

对每个 `业务日 + MT/ST`：

```text
机台数 = 当天该 MT/ST 类型具有有效 Availability 记录的不重复机台数

Availability = SUM(所有机台 Machine_Running 的 time_span)
               / (机台数 × 86400)

DUT-On = SUM(IN_QTY) / SUM(DUT_NUM)

Test Time = 0.2% 截尾平均测试秒数 × SUM(TD_Label)
            / SUM(测试秒数)

Yield = SUM(OUT_QTY) / SUM(IN_QTY)

日 Test OEE = Availability × DUT-On × Test Time × Yield
```

其中：

- 机台数从经过日期、LOT、PCIe 和 MT/ST 规则过滤后的全部 Availability 记录计算，不要求机台出现 `Machine_Running`。某台机即使当天全是 loss，也必须计入分母。
- `测试秒数 = END_TIME - START_TIME`，单位为秒。时间戳为空或 SQLite 无法解析时为 `NULL`，不进入截尾样本和秒数合计。
- `TD_Label = Integer(TOUCHDOWN_INDEX) / Integer(TOUCHDOWN_INDEX)` 的可计算结果。标准 SQL 将去除首尾空白后仅包含十进制数字且整数值非 0 的 `TOUCHDOWN_INDEX` 记为 `1`；空值、非整数文本和 `0` 记为 `NULL`。
- Spotfire 表达式 `TrimmedMean([Time_Span], 0.2)` 中的 `0.2` 是百分比参数，即 0.2%，实际比例为 `0.002`。最低端和最高端各去除 0.1%，每端比例为 `0.001`。若当天该类型有效测试秒数样本数为 `n`，每端去除 `floor(n × 0.001)` 行；标准 SQL 用整数除法 `n / 1000` 实现。
- 按测试秒数排序，相同秒数用事实表 `id` 稳定排序，只去除规定行数，不把边界处全部同值一并删除。
- 截尾只影响“截尾平均测试秒数”；分母 `SUM(测试秒数)` 和 `SUM(TD_Label)` 仍分别基于当天该类型的全部可计算值。
- 任一分母为 0 或必要输入为 `NULL` 时，对应比率及日 OEE 为 `NULL`，不是 0%。

### 日结果和多日结果

```text
日 Test OEE = 当天该 MT/ST 类型的四个汇总组成项相乘

多日 Test OEE = AVG(范围内可计算的日 Test OEE)
```

先在日类型粒度汇总各组成项的分子和分母，再计算比率并相乘。多日结果对可计算的业务日等权平均；不要把整个多日范围的原始分子分母一次汇总后相乘，也不要用机台数、产量或测试时间给日结果加权。

### 其他默认值

- Yield 包含所有 `test_stage`，包括 `1st`、`Rescreen` 和 `2ndRescreen`。
- 不限制比率上限，不舍入中间值，也不静默修正负值或其他源数据异常。

## 日期过滤与数据覆盖

两张事实表的 `date` 是 ISO 业务日标签。所有查询必须原样使用工具为本次范围返回的日期谓词；该谓词用日期前缀表达闭区间并包含结束业务日。

禁止直接将时间戳文本写成 `date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'`，这种写法会漏掉结束日带时间部分的记录。

默认 SQL 为范围内每个业务日生成 MT、ST 两行，并返回：

- `availability_rows`：当天该类型的有效 Availability 记录数。
- `machine_count`：Availability 分母采用的不重复机台数。
- `dut_rows`：当天该类型的有效 DUT 记录数；为 `NULL` 表示 Availability 日类型没有匹配 DUT 日类型。
- `valid_duration_rows`：进入测试时长统计的有效记录数。
- `trimmed_rows_each_tail`：当天该类型每端截尾的行数；实际从两端删除的总行数是其两倍。
- `calculable_day_count` / `selected_day_count`：多日平均实际使用的业务日数与所选业务日数。

任何计数不足都必须在回答中说明。无数据的业务日结果保持 `NULL`，多日 `AVG` 不把它当作 0；同时必须明确警告平均值只覆盖了哪些可计算业务日。不得把“查询范围正确”和“数据覆盖完整”混为一谈。

## 临时口径

用户指定的日期范围、数据范围、聚合、组成项或公式优先于默认口径。若用户修改固定关键规则、日类型聚合或多日平均方式，不要调用默认 SQL 生成器；改用 SQL 表达式工具组合查询，并在回答中列出差异。
