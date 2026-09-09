---
name: test-oee-calculator
description: 使用可组合的固定 LOT、MT/ST、平台回退和 Machine_Running 规则以及通用比率工具，查询、计算或解释 Test OEE。适用于默认口径和临时调整日期、范围、聚合、组成项或公式的 Test OEE 请求；不适用于 Assembly OEE。
---

# Test OEE 可组合计算

本技能不连接数据库，也不提供固定的一键 OEE 计算。使用 `execute_sql` 获取真实数据，并用本技能的纯规则工具和通用数值工具组合出本次结果。

## 工作流

1. 查询或计算前，读取 [references/database.md](references/database.md) 和 [references/business-rules.md](references/business-rules.md)。
2. 明确本次日期范围、数据范围、聚合方式、组成项和公式；用户指定的临时口径优先于参考文档中的默认计算口径。
3. 对每个使用的数据源调用 `test_oee_calculator__get_sql_expressions`，传入相同的 `start_date`、`end_date` 和相应表别名。将返回的 `dateRangePredicate`、固定 LOT 条件、MT/ST `CASE` 和 Availability 状态 `CASE` 原样组合进 `execute_sql`；不要另写日期条件。
4. 查询每个数据源在 `dateRangePredicate` 内的逐日行数，核对所选闭区间的首日、末日和中间每个自然日。缺日或某个组成项没有数据时不得静默视为完整周期；继续计算前先明确警告数据覆盖不完整及其对分母和结果的影响。
5. 优先让 SQLite 完成过滤和聚合。不要为了逐行调用规则工具而提取大量明细。
6. 将查询得到的原始分子、分母和常量交给 `test_oee_calculator__calculate_ratio_product`。只把本次公式需要的项目纳入乘积。
7. 回答前确认 Availability、DUT-On 和 Yield 的 SQL 均使用工具为本次返回的同一闭区间谓词，并抽查首日、末日是否被纳入。回答时说明查询范围、逐日数据覆盖、实际公式、各项分子与分母，以及相对默认口径的临时变化。分母为零表示“无法计算”，而不是 0%。

## 固定规则工具

- `test_oee_calculator__get_sql_expressions`：生成适用于 `oee_availability` 或 `oee_dut_utilization` 的固定规则 SQL 片段和时间戳安全的闭区间日期谓词。必须传入 `start_date`、`end_date`，可传入查询中的表别名。
- `test_oee_calculator__validate_lot_ids`：抽查或审计少量 `LOT_ID`。
- `test_oee_calculator__classify_mt_st`：抽查或审计少量记录的 MT/ST 类型与判定来源。
- `test_oee_calculator__classify_availability_states`：抽查或审计少量 Availability 状态及其是否为 `Machine_Running`。

这些工具固定实现当前 LOT、MT/ST、平台回退和 Machine_Running 规则。如果用户明确要求修改其中一项，不要使用对应的固定 SQL 片段或值判定结果；应按用户规则编写 `execute_sql`，并在回答中明确说明该偏差。

## 通用数值工具

`test_oee_calculator__calculate_ratio_product` 接受任意命名的分子/分母和常量因子。它不绑定 Test OEE 的默认公式，不做舍入、封顶或源值修正。可以通过 `include_in_product` 保留某项计算结果但不让它参与最终乘积。

默认口径只是起点，不是强制流程。公式说明、结果复核或口径调整均以 [references/business-rules.md](references/business-rules.md) 为基准，并以用户当前请求为准。
