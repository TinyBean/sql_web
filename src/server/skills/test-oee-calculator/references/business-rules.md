# Test OEE 业务规则

## 共享筛选与日期

- 两表所有指标、损失、覆盖及排名先用 `sourceLotPredicate` 排除 LOT 首字符为大写 Q/E 的记录。直接判断原值首字符，不去空格、不转换大小写；小写 q/e 不排除。筛选仅用于只读查询，不改原始数据。
- 仅 Yield 再用 `yieldLotPredicate` 保留 P/M/R/A/F/L 前缀 LOT，在 DUT 条件聚合中使用，不过滤共享基础数据。其余指标保留 None、X 等批次。Yield 保留所有 test_stage，包括初测和复测。
- `date` 是当天 08:30 至次日 08:30 的业务日标签，不按 START_TIME/END_TIME 再次移日。start_date/end_date 是闭区间；原样使用工具返回的日期前缀谓词，避免 BETWEEN 漏掉结束日带时间部分的记录。
- 业务周为周日至周六，完整周在次周日 08:30 结束。使用周日起始的 %U，标签 YYYY-Wnn；首个周日之前为 W00，不使用 %W 或 ISO 周。例如 2026-W36 为 09-06 至 09-12。
- 最近完整周取截止已结束业务日当日或之前最近的周六，向前六天。年内趋势跨年周按各自年份拆分并标为部分周；最近完整周保留七天，必要时跨年查询。趋势、极值与对应排名必须使用同一范围。
- 月、季使用自然周期；查询只纳入所选范围，不扩展边界。

## 分类与平台

Availability 使用 tool_name/step；DUT 使用 machine_id/step_id。两表统一关联键为 machine。

1. 先排除 PCIe 机台，使用实现中的 `PCIE_PLATFORM_MACHINE_IDS` 清单。
2. STEP 首字符 5 或前两字符 95 → MT；首字符 7 或前两字符 97 → ST。
3. 其余机台按 `ST_PLATFORM_MACHINE_IDS` 清单回退为 ST，否则未分类，不参与 OEE。

这些清单用于分类／排除；Skill 内部的 MACHINE_PLATFORMS 展示映射仅用于平台标签，不改变 MT/ST。未映射时显示“平台待维护/机台号”，不能根据 MT/ST 猜平台；未映射机台仍可按 STEP 分类。

### Machine_Running

按以下顺序派生状态，仅 Machine_Running 计入运行秒数：

| 原始状态及条件 | 派生状态 |
|---|---|
| Assistance／HangUp，LOT 为 None | IDLE |
| Assistance／HangUp，其余 LOT | 原状态 |
| Conversion、PM、Handler_Flush、IDLE_NoWIP、IDLE_WaitARV、IDLE、Not_Defined | 原状态 |
| IDLE_NoWIP(NoTask)、IDLE_NoTask(xCurrentLot) | IDLE_NoWIP |
| 其余 IDLE_NoTask( 开头的状态 | IDLE_NoTask |
| HANDLER_PAUSE(Golden)、Handler_Executing(Golden)、Loader_Unload(Golden)、Machine_Initialize(Golden)、Temp_Down(Golden)、Temp_Up(Golden)、Test(Golden) | Golden_run_time |
| Temp_Up(Normal Retest)，LOT 为 None | Other |
| 其余状态 | Machine_Running |

默认分支包含 Retest(Golden)、RMS_Initialize(Golden) 和含 Golden Retest 的状态。Idle 指标另按原始 final_state 包含大写子串 IDLE 判断，不使用派生状态。

## 公式与粒度

各组先独立汇总两表，以 Availability 为主按相同粒度左连接 DUT。仅有 DUT 的组不输出 OEE；必要组成项缺失时保留 NULL。

| 口径 | Test Time 均值样本范围 | 总截尾 | 每端删除 | Test Time 上限 | 多日／周期 OEE |
|---|---|---|---|---|---|
| 全类型 | 同业务日、同 MT/ST 的全部合格 DUT，包含无匹配 Availability 机台的 DUT | 0.2% | floor(n/1000) | 不封顶 | 对各类型可计算日 OEE 等权平均 |
| 单机台 | 同周期、同机台、同 MT/ST 的全部合格 DUT，包含该机台周期内 DUT-only 业务日 | 1% | floor(n/200) | 100% | 汇总周期组成项后相乘 |

单机台 grain 为 day/week/month/quarter；排名使用整个所选日期范围作为一个周期。全类型概览不能通过平均机台 OEE 得到。

```text
Availability = Machine_Running 状态秒数 / 全部状态秒数
Idle = 原始状态包含 IDLE 的状态秒数 / 全部状态秒数
Effective Availability = Availability + Idle / (1 + (1 - Idle - Availability))
Performance (DUT-On) = SUM(IN_QTY) / SUM(DUT_NUM)
Performance (Test Time) = TrimmedMean(测试秒数, 截尾参数) × SUM(TD_Label) / SUM(测试秒数)
Yield = SUM(Yield 合格 OUT_QTY) / SUM(Yield 合格 IN_QTY)
Test OEE = Availability × DUT-On × Test Time × Yield
Effective OEE = Effective Availability × DUT-On × Test Time × Yield
```

- 测试秒数为 END_TIME－START_TIME 的秒数，保留毫秒精度；无法解析的时间为 NULL。DUT_NUM 直接作 Socket 分母，不额外乘 768。
- TD_Label：TOUCHDOWN_INDEX 去除两端空白后为非零整数（允许正负号）时取 1，否则 NULL。
- n 只统计非空测试秒数。按秒数、事实表 id 排序，两端按行数截尾，边界同值不整组删除。截尾参数表示总百分比，两端各取一半。
- 截尾仅影响均值；TD 总和和测试秒数总和分别保留全部非空值，不过滤为共同样本，也不移除截尾行。样本不足截尾边界且时间和 TD 均有效时 Test Time 为 100%，不能据此断言没有效率损失。
- 单机台先保留 raw_test_time_performance，再将超过 1 的值封顶得到 test_time_performance。其他比率及 OEE 不封顶，不舍入中间值，不额外裁剪负值。
- 分母为零或必要输入缺失时为 NULL，不补零或 100%。无 Yield 合格记录时 yield_rows=0，Yield 的数量总和及比率为 NULL。
- 全类型多日 Test OEE 与 Effective OEE 分别平均自身可计算日，实际日数可能不同。period_test_oee/period_effective_oee 是每行重复的期间值，不再次求和或平均；OEE 不等于组成项均值的乘积。

## 输出与覆盖

- 全类型 daily 为每个所选业务日生成 MT、ST 两行，包括缺数据日。availability_rows、machine_count、dut_rows、yield_rows 用于检查来源；machine_count 不参与 Availability 分母。
- available_seconds 是全部有效状态秒数，idle_seconds 是其中原始状态包含 IDLE 的秒数。input_quantity/output_quantity/socket_quantity 是共享 DUT 总和；Yield 使用独立的 yield_input_quantity/yield_output_quantity。
- valid_duration_rows、trimmed_rows_each_tail、trimmed_mean_test_seconds、touchdown_count、actual_test_seconds 是 Test Time 审计组成项。
- 全类型 selected_day_count 与 calculable_day_count/effective_calculable_day_count 分别表示所选日数和实际平均日数；dut_rows 为 NULL 表示该 Availability 日类型没有匹配 DUT。
- 单机台 period_label、period_start、period_end 表示查询范围内周期标签及边界，is_partial_period 标识边界不完整；availability_days/dut_days 为实际覆盖日数，不从边界天数推算。不补缺机台周期。
- 没有数据不是零损失，也不代表完整覆盖。回答需说明不可计算项及实际覆盖不足；导入完整性调查见 [导入审计](import-audit.md)。
- 明细及多日值是原始比率，1 表示 100%；看板 _percent 列与排名 value/metric_value 已乘 100，损失为小时。Performance (DUT-On) 与 Performance (Test Time) 分开展示，旧 performance 字段仅为 DUT-On 别名。看板字段与平均样本见 [字段映射](dashboard.md)。

## 排名与历史结果

- rank_machines 对同范围、同 MT/ST 的 distinct 机台取 TOP3：loss_hours 降序，其余指标升序，并列按未舍入数值及机台号。states 只适用于 loss_hours；省略时统计全部非运行状态。NULL 不排名，不足三台返回实际数量。
- 损失占比分母为同范围、同类型、同状态筛选下全部候选机台的损失。快照保留完整候选、原始机台号、平台标签与覆盖，TOP3 预览不代表数据截断。分析引用 summary 原文；派生排名不能作为实测 loss_reference。
- TOP10 在极值所对应周期按机台去重。MT/ST 分别计算本机台周期截尾标准，再汇总“各类型标准秒数×各类型 TD 次数”除以整机实际测试秒数，最后封顶。必要类型组成项缺失则为 NULL；其余指标按整机原始总量计算。主要类型由 Availability 累计时长确定，并列取 MT。
- 新排名内部 basis=report_period、testTimeRule=machine_period_1pct，basis 不作为查询参数。历史 machine_day 标记及缺少新规则标记的整期快照保留原数值和原口径说明，后者使用旧日类型 0.2% 标准；不主动重算历史看板或快照。

## 自定义口径与抽查

用户明确改变固定规则时，对受影响部分使用 get_sql_expressions 编写查询，说明偏差。原样复用未改变的日期、平台、分类、状态和基础 LOT 表达式；yieldLotPredicate 仅用于 Yield 条件聚合。

少量记录抽查可在 VALUES 中提供用户给定字段，使用返回的表达式，不手写另一套分类规则。例如 DUT 来源返回 e，table_alias=d：

```text
WITH samples(machine_id,step_id,lot_id) AS (VALUES ('ADH001','5000','P1'))
SELECT e.kindExpression AS kind,
       e.platformPredicate AS included_platform,
       e.sourceLotPredicate AS included_source,
       e.yieldLotPredicate AS yield_eligible
FROM samples AS d
```

将 e.* 替换为工具返回的 SQL 片段，再交给 execute_sql。Availability 抽查提供 tool_name、step、lot_id、final_state，使用对应来源的 kindExpression、availabilityStateExpression 和 idlePredicate。
