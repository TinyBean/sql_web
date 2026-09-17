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

Availability 使用 `oee_availability.step` 和 `oee_availability.tool_name`；Performance 和 Yield 使用 `oee_dut_utilization.step_id` 和 `oee_dut_utilization.machine_id`。先应用 PCIe 排除，再按以下顺序判定：

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
- 用户选择的日期是业务日闭区间；三个组成项必须使用同一范围。
- 两张事实表先分别计算到 `业务日 + MT/ST` 粒度，再以 Availability 日结果为主表，按这两个键左连接 DUT 日结果。
- DUT 中没有对应 Availability 日类型的结果不进入默认 OEE；Availability 没有匹配 DUT 或任一组成项无法计算时，该日该类型 OEE 为 `NULL`。

### 业务周与周编号

- 一个业务周为周日至周六的七个业务日闭区间。每个业务日仍为当天 08:30 至次日 08:30，因此完整业务周在次周日 08:30 结束。
- 周编号使用周日起始的 `%U`，标签为 `YYYY-Wnn`；每年首个周日开始 W01，之前的业务日为 W00。不得使用周一起始的 `%W` 或 ISO 周编号。
- 例如 2026-W36 对应业务日 **2026-09-06 至 2026-09-12**；2026-09-13 已属于 W37。2026-W00 为 01-01 至 01-03，W01 为 01-04 至 01-10。
- “最近完整周”取截止已结束业务日当日或之前最近的周六作为结束日，向前六天为开始日。截止日为周六时包含该周；截止日为周日时，结束日是前一天周六。例如截至业务日 2026-09-16，最近完整周为 09-06 至 09-12。
- 年内趋势仍从 1 月 1 日开始，跨年周在趋势中按各自年份拆分并标注部分周；最近完整周保留完整七天，必要时跨年查询。周趋势、周极值、对应机台排名和周改善分析须使用一致的周范围。
- 历史快照可能采用旧周定义。解释既有快照时保留其原日期与口径；按新定义查询或更新周卡片时重新计算对应日期范围，不能只改周标签。

### 单日组成项

对每个 `业务日 + MT/ST`：

```text
机台数 = 当天该 MT/ST 类型具有有效 Availability 记录的不重复机台数

Availability = SUM(所有机台 Machine_Running 的 time_span)
               / (机台数 × 86400)

Performance = SUM(IN_QTY) / SUM(DUT_NUM)

Yield = SUM(OUT_QTY) / SUM(IN_QTY)

日 Test OEE = Availability × Performance × Yield
```

其中：

- 机台数从经过日期、LOT、PCIe 和 MT/ST 规则过滤后的全部 Availability 记录计算，不要求机台出现 `Machine_Running`。某台机即使当天全是 loss，也必须计入分母。
- 任一分母为 0 或必要输入为 `NULL` 时，对应比率及日 OEE 为 `NULL`，不是 0%。

### 日结果和多日结果

```text
日 Test OEE = 当天该 MT/ST 类型的三个汇总组成项相乘

多日 Test OEE = AVG(范围内可计算的日 Test OEE)
```

先在日类型粒度汇总各组成项的分子和分母，再计算比率并相乘。多日结果对可计算的业务日等权平均；不要把整个多日范围的原始分子分母一次汇总后相乘，也不要用机台数或产量给日结果加权。

### 数值与展示单位

- 默认逐日 SQL 的 `availability`、`performance`、`final_yield`、`daily_test_oee` 和 `period_test_oee` 均为 0–1 比率。
- 指标解释和界面显示必须使用 `Performance`。
- 默认看板 SQL 中以 `_percent` 结尾的列为百分数值（percentage points），已经乘以 100；例如 `56.65` 表示 `56.65%`。
- Dashboard 的 `format.unit: "%"` 只追加单位，不会把 `0.5665` 自动换算为 `56.65`。不得把默认逐日 SQL 的比率列直接映射到 `%` 看板。

### 其他默认值

- Yield 包含所有 `test_stage`，包括 `1st`、`Rescreen` 和 `2ndRescreen`。
- 不限制比率上限，不舍入中间值，也不静默修正负值或其他源数据异常。

### 概览字段映射与核对

`get_default_dashboard_sql(view: "overview")` 返回一行，可保存为一个快照供多张概览卡片引用。该行同时包含合并指标和分类指标，按以下映射选择字段：

| 卡片口径 | OEE（`encoding.value`） | Availability | Performance | Yield |
|---|---|---|---|---|
| MT | `mt_oee_percent` | `mt_availability_percent` | `mt_performance_percent` | `mt_yield_percent` |
| ST | `st_oee_percent` | `st_availability_percent` | `st_performance_percent` | `st_yield_percent` |
| MT/ST 合并 | `overall_oee_percent` | `avg_availability_percent` | `avg_performance_percent` | `avg_yield_percent` |

三个组成项分别写入 `encoding.gauges[].column`。分类四项指标均对该类型 OEE 可计算业务日等权平均，合并四项指标均对全部可计算日类型等权平均。不能将分类 OEE 搭配共享快照中的合并 `avg_*` 系数。

分类覆盖使用同类型前缀，以下 `{type}` 为 `mt` 或 `st`：

| 字段 | 含义 |
|---|---|
| `{type}_calculable_day_count` | 该类型日 OEE 非 NULL 的业务日数，也是四项平均值共同的样本数 |
| `{type}_selected_day_count` | 所选闭区间的业务日数，包含无数据日 |
| `{type}_availability_day_count` | 该类型有有效 Availability 记录的业务日数，包含全为 loss 的日 |
| `{type}_dut_day_count` | 该类型 Availability 日结果有匹配 DUT 的业务日数，包含因零分母而 OEE 不可计算的日 |

合并覆盖沿用 `calculable_day_type_count`、`selected_day_type_count`、`availability_day_type_count`、`dut_day_type_count`，单位为日类型，不能除以二推算某一类型的覆盖。

提交 `update_dashboard` 前核对字段映射、日期、分类覆盖和卡片标题、说明一致。仅修改标题或 OEE 字段不会自动筛选三个系数。旧快照缺少分类字段时，用当前工具重新生成 SQL 并执行保存，不从合并均值补齐。

OEE 保持 `AVG(日 Availability × 日 Performance × 日 Yield)`，不要求等于三个平均系数的乘积。MT/ST 系数可能真实相同，不能仅按数值相同判错；应核对分类字段及其计算样本。

## 日期过滤与数据覆盖

两张事实表的 `date` 是 ISO 业务日标签。所有查询必须原样使用工具为本次范围返回的日期谓词；该谓词用日期前缀表达闭区间并包含结束业务日。

禁止直接将时间戳文本写成 `date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'`，这种写法会漏掉结束日带时间部分的记录。

默认 SQL 为范围内每个业务日生成 MT、ST 两行，并返回：

- `availability_rows`：当天该类型的有效 Availability 记录数。
- `machine_count`：Availability 分母采用的不重复机台数。
- `dut_rows`：当天该类型的有效 DUT 记录数；为 `NULL` 表示 Availability 日类型没有匹配 DUT 日类型。
- `calculable_day_count` / `selected_day_count`：多日平均实际使用的业务日数与所选业务日数。

任何计数不足都必须在回答中说明。无数据的业务日结果保持 `NULL`，多日 `AVG` 不把它当作 0；同时必须明确警告平均值只覆盖了哪些可计算业务日。不得把“查询范围正确”和“数据覆盖完整”混为一谈。

## 临时口径

用户指定的日期范围、数据范围、聚合、组成项或公式优先于默认口径。若用户修改固定关键规则、日类型聚合或多日平均方式，不要调用默认 SQL 生成器；改用 SQL 表达式工具组合查询，并在回答中列出差异。
