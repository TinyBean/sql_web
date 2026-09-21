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

Availability 使用 `oee_availability.step` 和 `oee_availability.tool_name`；Performance (DUT-On)、Performance (Test Time) 和 Yield 使用 `oee_dut_utilization.step_id` 和 `oee_dut_utilization.machine_id`。先应用 PCIe 排除，再按以下顺序判定：

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

Performance (DUT-On) = SUM(IN_QTY) / SUM(DUT_NUM)

Performance (Test Time) = TrimmedMean(Time_Span, 0.2) × SUM(TD_Label) / SUM(Time_Span)

Yield = SUM(OUT_QTY) / SUM(IN_QTY)

日 Test OEE = Availability × Performance (DUT-On) × Performance (Test Time) × Yield

Idle = SUM(原始 FINAL_STATE 中包含 'IDLE' 的 time_span) / (机台数 × 86400)

Effective Availability = Availability + Idle / (1 + (1 - Idle - Availability))

日 Effective OEE = Effective Availability × Performance (DUT-On) × Performance (Test Time) × Yield
```

其中：

- 机台数从经过日期、LOT、PCIe 和 MT/ST 规则过滤后的全部 Availability 记录计算，不要求机台出现 `Machine_Running`。某台机即使当天全是 loss，也必须计入分母。
- Idle 沿用 Availability 的全部过滤、日类型粒度和机台分母，累加原始 `final_state` 中包含大写子串 `IDLE` 的所有状态秒数，使用 `instr(final_state,'IDLE')>0`，区分大小写且不限子串位置；包含 `IDLE_NoWIP`、`IDLE_WaitARV`、`IDLE_NoTask(...)` 等变体，不使用派生 `state_group`。有效 Availability 记录中没有任何包含 `IDLE` 的状态时，`idle_seconds` 和 `idle` 为 0；没有有效 Availability 记录时为 `NULL`。
- Effective Availability 的分母 `1 + (1 - Idle - Availability)` 为 0 或必要输入缺失时，Effective Availability 和日 Effective OEE 为 `NULL`，不影响原 Test OEE。分母为负时照公式计算，不封顶、不修正源值。
- `Time_Span` 来自 DUT 的 `END_TIME - START_TIME`，单位为秒，使用 `unixepoch(..., 'subsec')` 保留小数秒。时间戳为空或无法解析时为 `NULL`。
- `TD_Label` 对去除首尾空白后的非零十进制整数文本（允许单个正负号）取 1；空、非法文本和零取 `NULL`。
- `TrimmedMean(Time_Span, 0.2)` 总共截去 0.2%，两端各 0.1%。对当天该类型非空时间样本 n，按秒数、事实表 id 排序，每端删除 `floor(n / 1000)` 行；边界同值不整组删除。
- 截尾只影响均值，`SUM(TD_Label)` 与 `SUM(Time_Span)` 各自使用组内全部非空值，不能先筛成两个字段都有效的共同样本。小于 1000 条不截尾，且每条 TD 均有效时 Test Time 为 100%，这是公式结果。
- 数据库已有全部源字段，无需新增 IE 标准时间表；`DUT_NUM` 直接作为 Socket 分母，不额外乘 768。
- 任一分母为 0 或必要输入为 `NULL` 时，对应比率及日 OEE 为 `NULL`，不是 0%。

### 日结果和多日结果

```text
日 Test OEE = 当天该 MT/ST 类型的四个汇总组成项相乘

多日 Test OEE = AVG(范围内可计算的日 Test OEE)

多日 Effective OEE = AVG(范围内可计算的日 Effective OEE)
```

先在日类型粒度汇总各组成项的分子和分母，再计算比率并相乘。两种多日结果分别对自身可计算的业务日等权平均；不要把整个多日范围的原始分子分母一次汇总后相乘，也不要用机台数或产量给日结果加权。`period_test_oee` 与 `period_effective_oee` 在每日行重复展示同类型多日值，不得再次求和或平均。

### 数值与展示单位

- 默认逐日 SQL 的 `availability`、`dut_on`、`test_time_performance`、`final_yield`、`daily_test_oee` 和 `period_test_oee` 均为原始比率（1 表示 100%，不限制上下界）。
- 新增 `idle`、`effective_availability`、`daily_effective_oee` 和 `period_effective_oee` 也为原始比率；`idle_seconds` 是秒数，不是百分比。
- 指标解释和界面显示使用 `Performance (DUT-On)` 与 `Performance (Test Time)`。旧 `performance` 及 `*_performance_percent` 仅为 DUT-On 的兼容别名，不能充当两项的乘积。
- 默认看板 SQL 中以 `_percent` 结尾的列为百分数值（percentage points），已经乘以 100；例如 `56.65` 表示 `56.65%`。
- Dashboard 的 `format.unit: "%"` 只追加单位，不会把 `0.5665` 自动换算为 `56.65`。不得把默认逐日 SQL 的比率列直接映射到 `%` 看板。

### 其他默认值

- Yield 包含所有 `test_stage`，包括 `1st`、`Rescreen` 和 `2ndRescreen`。
- 不限制比率上限，不舍入中间值，也不静默修正负值或其他源数据异常。

### 概览字段映射与核对

`get_default_dashboard_sql(view: "overview")` 返回一行，可保存为一个快照供多张概览卡片引用。该行同时包含合并指标和分类指标，按以下映射选择字段：

| 卡片口径 | OEE（`encoding.value`） | Availability | Performance (DUT-On) | Performance (Test Time) | Yield |
|---|---|---|---|---|---|
| MT | `mt_oee_percent` | `mt_availability_percent` | `mt_dut_on_percent` | `mt_test_time_percent` | `mt_yield_percent` |
| ST | `st_oee_percent` | `st_availability_percent` | `st_dut_on_percent` | `st_test_time_percent` | `st_yield_percent` |
| MT/ST 合并 | `overall_oee_percent` | `avg_availability_percent` | `avg_dut_on_percent` | `avg_test_time_percent` | `avg_yield_percent` |

四个组成项分别写入 `encoding.gauges[].column`。分类五项指标均对该类型 OEE 可计算业务日等权平均，合并五项指标均对全部可计算日类型等权平均。不能将分类 OEE 搭配共享快照中的合并 `avg_*` 系数。

分类覆盖使用同类型前缀，以下 `{type}` 为 `mt` 或 `st`：

| 字段 | 含义 |
|---|---|
| `{type}_calculable_day_count` | 该类型日 OEE 非 NULL 的业务日数，也是五项平均值共同的样本数 |
| `{type}_selected_day_count` | 所选闭区间的业务日数，包含无数据日 |
| `{type}_availability_day_count` | 该类型有有效 Availability 记录的业务日数，包含全为 loss 的日 |
| `{type}_dut_day_count` | 该类型 Availability 日结果有匹配 DUT 的业务日数，包含因零分母而 OEE 不可计算的日 |

合并覆盖沿用 `calculable_day_type_count`、`selected_day_type_count`、`availability_day_type_count`、`dut_day_type_count`，单位为日类型，不能除以二推算某一类型的覆盖。

提交 `update_dashboard` 前核对字段映射、日期、分类覆盖和卡片标题、说明一致。仅修改标题或 OEE 字段不会自动筛选四个系数。旧快照缺少分类字段时，用当前工具重新生成 SQL 并执行保存，不从合并均值补齐。

OEE 保持 `AVG(日 Availability × 日 Performance (DUT-On) × 日 Performance (Test Time) × 日 Yield)`，不要求等于四个平均系数的乘积。MT/ST 系数可能真实相同，不能仅按数值相同判错；应核对分类字段及其计算样本。

### Effective OEE 概览字段映射

同一 `overview` 快照同时提供 Effective OEE。原 Test OEE 字段及其计算样本保持不变。Effective OEE 的主值分别使用 `mt_effective_oee_percent`、`st_effective_oee_percent` 和合并的 `overall_effective_oee_percent`。

以下 `{p}` 为 `mt`、`st` 或合并的 `avg`，同一卡片必须保持前缀一致：

| 指标 | 字段 |
|---|---|
| Idle | `{p}_idle_percent` |
| Effective Availability | `{p}_effective_availability_percent` |
| Performance (DUT-On) | `{p}_effective_dut_on_percent` |
| Performance (Test Time) | `{p}_effective_test_time_percent` |
| Yield | `{p}_effective_yield_percent` |

四个乘积组成项映射到 `encoding.gauges[].column`；Idle 是用于解释 Effective Availability 的辅助指标，不额外乘入 OEE。所有这些概览字段仅平均对应类型或合并范围中 **日 Effective OEE 非 NULL** 的行。Performance 和 Yield 的日公式没有改变，独立字段用于保证平均样本一致；不能借用原 Test OEE 概览的组成项均值。

分类覆盖使用 `{mt|st}_effective_calculable_day_count`，合并覆盖使用 `effective_calculable_day_type_count`。日期、Availability 和 DUT 覆盖计数复用原字段。新分母为零时，Effective OEE 覆盖可能少于 Test OEE；覆盖不足须明确说明。

`trends` 提供 `{mt|st}_idle_percent`、`{mt|st}_effective_availability_percent` 和 `{mt|st}_effective_oee_percent`；逐日 Idle 和 Effective Availability 展示其自身可计算值，不因缺少 DUT 隐藏，日 Effective OEE 仍要求所有乘积组成项有效。所有 `_percent` 值已乘 100。缺少新增字段的历史快照需要重新查询，不能补零；新增指标不会自动修改默认看板、机台排名或历史快照。

## 日期过滤与数据覆盖

两张事实表的 `date` 是 ISO 业务日标签。所有查询必须原样使用工具为本次范围返回的日期谓词；该谓词用日期前缀表达闭区间并包含结束业务日。

禁止直接将时间戳文本写成 `date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'`，这种写法会漏掉结束日带时间部分的记录。

默认 SQL 为范围内每个业务日生成 MT、ST 两行，并返回：

- `availability_rows`：当天该类型的有效 Availability 记录数。
- `machine_count`：Availability 分母采用的不重复机台数。
- `idle_seconds` / `idle`：原始状态包含 `IDLE` 的累计秒数及其占 `available_seconds` 的比率。
- `dut_rows`：当天该类型的有效 DUT 记录数；为 `NULL` 表示 Availability 日类型没有匹配 DUT 日类型。
- `touchdown_count`、`actual_test_seconds`、`trimmed_mean_test_seconds`：Test Time 的 TD 次数、实际测试总秒数、截尾标准秒数。
- `valid_duration_rows`、`trimmed_rows_each_tail`：有效时间样本数及每端截去的样本数。
- `calculable_day_count` / `selected_day_count`：多日平均实际使用的业务日数与所选业务日数。
- `effective_calculable_day_count`：该类型日 Effective OEE 非 NULL 的业务日数；`period_effective_oee` 只平均这些日。

任何计数不足都必须在回答中说明。无数据的业务日结果保持 `NULL`，多日 `AVG` 不把它当作 0；同时必须明确警告平均值只覆盖了哪些可计算业务日。不得把“查询范围正确”和“数据覆盖完整”混为一谈。

## 机台 TOP10

机台 OEE 保留整期汇总：Availability × DUT-On × Test Time × Yield。机台周期 Test Time = `SUM(当天同类型标准秒数 × 该机台当天同类型 TD 次数) / SUM(该机台实际测试秒数)`。标准秒数来自当天该类型全部合格 DUT 记录，包括没有匹配 Availability 的 DUT，不能按机台重新计算截尾均值。周期中所需日类型标准缺失时该机台 Test Time 为 NULL，不参与排名。MT/ST 仍合并为一台，以 Availability 累计秒数标注主要类型，并列取 MT。

旧快照保留历史结果并标明旧公式，缺失 Test Time 不反推、不补 100%；默认看板更新需从事实数据重算所有指标和分析。

## 临时口径

用户指定的日期范围、数据范围、聚合、组成项或公式优先于默认口径。若用户修改固定关键规则、日类型聚合或多日平均方式，不要调用默认 SQL 生成器；改用 SQL 表达式工具组合查询，并在回答中列出差异。
