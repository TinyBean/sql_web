---
name: test-oee-calculator
description: 使用可组合的固定 LOT、MT/ST、平台回退和 Machine_Running 规则以及可信 SQL/Python 数据链路，查询、计算或解释 Test OEE。适用于默认口径和临时调整日期、范围、聚合、组成项或公式的 Test OEE 请求；不适用于 Assembly OEE。
---

# Test OEE 可组合计算

本技能不连接数据库，也不提供固定的一键 OEE 计算。使用 `execute_sql` 获取真实数据，并用本技能的纯规则工具和通用数值工具组合出本次结果。

## 工作流

1. 查询或计算前，读取 [references/database.md](references/database.md) 和 [references/business-rules.md](references/business-rules.md)。
2. 明确本次日期范围、数据范围、聚合方式、组成项和公式；用户指定的临时口径优先于参考文档中的默认计算口径。
3. 对每个使用的数据源调用 `test_oee_calculator__get_sql_expressions`，传入相同的 `start_date`、`end_date` 和相应表别名。将返回的 `dateRangePredicate`、固定 LOT 条件、MT/ST `CASE` 和 Availability 状态 `CASE` 原样组合进 `execute_sql`；不要另写日期条件。
4. 查询每个数据源在 `dateRangePredicate` 内的逐日行数，核对所选闭区间的首日、末日和中间每个自然日。缺日或某个组成项没有数据时不得静默视为完整周期；继续计算前先明确警告数据覆盖不完整及其对分母和结果的影响。
5. 优先让 SQLite 在同一条查询中完成过滤、聚合、比率和乘积，不要把数据库查询结果复制到其他工具参数或 Python 代码中。分母为零时用 `CASE WHEN denominator=0 THEN NULL`，不要舍入、封顶或修正源值。
6. 只有同一条 SQL 无法完成所需统计或需要 PNG 渲染时，才调用 `code_interpreter`。先用 `execute_sql.save_as` 将完整查询结果保存为简短有意义的会话级数据快照，再把返回的规范逻辑名称传入 `code_interpreter.snapshot`；不得复制查询预览。Python 优先直接遍历 `snapshot_rows`，它是 `list[dict]`，使用 `row["列名"]` 访问，严禁再用 `zip(columns, row)` 重建。用户明确给出的常量放入独立的 `user_input`。代码必须调用一次 `emit_result` 返回指标和中间量，并在排序、取首项或 `min`/`max` 前处理空集合。后续绘图或复算应复用快照，只有需要刷新数据库事实时才覆盖同名快照。
7. 回答前确认 Availability、DUT-On 和 Yield 的 SQL 均使用工具为本次返回的同一闭区间谓词，并抽查首日、末日是否被纳入。回答时说明查询范围、逐日数据覆盖、实际公式、各项分子与分母，以及相对默认口径的临时变化。分母为零表示“无法计算”，而不是 0%。

## 固定规则工具

- `test_oee_calculator__get_sql_expressions`：生成适用于 `oee_availability` 或 `oee_dut_utilization` 的固定规则 SQL 片段和时间戳安全的闭区间日期谓词。必须传入 `start_date`、`end_date`，可传入查询中的表别名。
- `test_oee_calculator__validate_lot_ids`：抽查或审计少量 `LOT_ID`。
- `test_oee_calculator__classify_mt_st`：抽查或审计少量记录的 MT/ST 类型与判定来源。
- `test_oee_calculator__classify_availability_states`：抽查或审计少量 Availability 状态及其是否为 `Machine_Running`。

这些工具固定实现当前 LOT、MT/ST、平台回退和 Machine_Running 规则。如果用户明确要求修改其中一项，不要使用对应的固定 SQL 片段或值判定结果；应按用户规则编写 `execute_sql`，并在回答中明确说明该偏差。

## 数值计算

数据库派生的比率和乘积必须在生成这些原始值的同一条 SQL 中完成，或将完整 SQL 结果保存为快照后通过 `code_interpreter.snapshot` 注入沙箱。不得让模型把 `execute_sql` 返回的分子、分母或预览行再次抄写到其他工具参数或 Python 数据字面量中。纯计算实现仍作为规则测试基准，不作为 Agent 工具发布。

默认口径只是起点，不是强制流程。公式说明、结果复核或口径调整均以 [references/business-rules.md](references/business-rules.md) 为基准，并以用户当前请求为准。
