---
name: test-oee-calculator
description: 使用固定 LOT、PCIe 平台排除、MT/ST、Machine_Running、Performance、Yield 和业务日聚合规则，以可信 SQLite 数据链路查询、计算或解释 Test OEE。适用于默认口径及明确的临时口径调整；不适用于 Assembly OEE。
---

# Test OEE 计算

本技能不直接连接数据库。规则工具只生成或验证确定性的 SQL 和分类结果；数据库事实必须来自 `execute_sql`。

## 工作流

1. 查询或计算前，完整读取 [references/database.md](references/database.md) 和 [references/business-rules.md](references/business-rules.md)。
2. 明确用户选择的业务日闭区间。事实表 `date` 已是“当天 08:30 至次日 08:30”的业务日标签，不要按 `start_time`、`end_time` 再次移日。业务周为周日至周六，周编号采用周日起始的 `%U`（年初首个周日之前为 W00），不得使用周一起始的 `%W` 或 ISO 周。周范围与“最近完整周”按[业务周与周编号](references/business-rules.md#业务周与周编号)确定。
3. 使用默认口径回答或审计时，调用 `test_oee_calculator__get_default_sql`，传入 `start_date`、`end_date`，再将返回的 `sql` 原样交给 `execute_sql`。不要手工简化 CTE、改变左连接方向或先算机台 OEE 再平均。
4. 使用默认口径更新结构化看板时，按所需图表调用 `test_oee_calculator__get_default_dashboard_sql`：概览选 `overview`，日趋势选 `trends`；仅增加概览无需查询趋势。将返回的 `sql` 原样交给 `execute_sql.save_as`，不要手写新的 CTE。更新卡片前按[概览字段映射与核对](references/business-rules.md#概览字段映射与核对)核对快照字段及覆盖：MT/ST 概览的四项指标必须使用同一类型前缀，覆盖计数也使用该前缀；共享合并快照中的 `avg_*` 仅用于合并概览。缺少分类字段时重新生成快照，不借用混合指标。所有 `_percent` 列已经是百分数值，例如 `56.65` 表示 `56.65%`，可直接映射到 `unit: "%"`；不得再次乘以 100。默认逐日 SQL 的比率列不能直接映射成带 `%` 单位的看板值。
5. 默认 SQL 在 `业务日 + MT/ST` 粒度分别汇总 Availability、Performance 和 Yield，以 Availability 日结果为主左连接 DUT 日结果，再将三项相乘得到日 OEE。Availability 分母中的机台数是当天该类型具有有效 Availability 记录的不重复机台数；即使某台机全是 loss，也必须保留在分母中。多日 OEE 是可计算日 OEE 的等权平均。最终多日值读取 `period_test_oee`，不要对这个重复展示在每日行上的值再次求和或平均。
6. 核对默认 SQL 返回的每个所选业务日均有 MT、ST 两行，并检查 `availability_rows`、`machine_count`、`dut_rows`、`calculable_day_count` 和 `selected_day_count`。缺数据和不可计算项必须明确警告，不能视为 0 或完整覆盖。
7. 用户临时修改日期范围以外的计算规则时，不使用默认 SQL。分别为 Availability 和 DUT 调用 `test_oee_calculator__get_sql_expressions`，传入相同日期与对应表别名；原样复用返回的日期、LOT、平台、MT/ST 和状态表达式，仅改动用户指定的部分。回答中列出与默认口径的差异。
8. 优先让 SQLite 在同一条查询中完成过滤、聚合、窗口排序、比率、连接和乘积。所有分母用 `CASE` 防止除零；不舍入中间值，不封顶或静默修正源值。
9. 只有同一条 SQL 无法完成所需统计或需要 PNG 时才使用 `code_interpreter`。先由 `execute_sql.save_as` 保存完整、未截断的查询结果，再传规范快照名；不得复制 SQL 预览或数据库数字到 Python 字面量。优先直接遍历 `snapshot_rows`；它是 `list[dict]`，用 `row["列名"]` 取值，严禁再用 `zip(columns, row)` 重建。代码必须调用一次 `emit_result`，并在空集合、首项、`min`/`max` 和除法前处理空值。
10. 回答时说明业务日范围、实际覆盖、连接粒度、公式、各项分子分母以及多日实际纳入的日数。分母为零或必要输入缺失表示“无法计算”，不是 0%。解释和界面展示一律使用 `Performance`。

## 固定规则工具

- `test_oee_calculator__get_default_sql`：生成完整的默认 SQLite 查询。PCIe 排除优先；结果包含 Availability、Performance、Yield、逐日与多日 Test OEE 及覆盖计数。
- `test_oee_calculator__get_default_dashboard_sql`：从同一默认逐日查询生成单行概览（合并及 MT/ST 分类指标、各自覆盖计数）或 MT/ST 宽表趋势；`_percent` 列为可直接展示的百分数值。
- `test_oee_calculator__get_sql_expressions`：为自定义查询生成时间戳安全的闭区间业务日谓词，以及 LOT、PCIe 平台、MT/ST 和 Machine_Running SQL 片段。
- `test_oee_calculator__validate_lot_ids`：抽查或审计少量 `LOT_ID`。
- `test_oee_calculator__classify_mt_st`：抽查少量记录的 MT/ST 判定，并指出机台是否因 PCIe 平台被排除以及能否进入 OEE。
- `test_oee_calculator__classify_availability_states`：抽查 Availability 派生状态及其是否为 `Machine_Running`。

若用户明确修改某项固定规则，不要使用受影响的固定 SQL 或分类结果；按用户规则编写查询并说明偏差。

## 结果口径

默认公式和异常处理以 [references/business-rules.md](references/business-rules.md) 为唯一业务规则来源。纯数值计算函数只作为回归测试基准，不作为 Agent 工具发布。
