---
name: test-oee-calculator
description: 查询、计算和解释 Test OEE 与 Effective OEE，支持全类型概览、机台日/周/月/季明细、自定义口径及问题指标 TOP3；查询每日或当日看板的生成状态、运行过程、失败原因及报告依据。不适用于 Assembly OEE。
---

# Test OEE 与 Effective OEE

## 读取指引

- 首次查询或解释口径，读取 [业务规则](references/business-rules.md)；生成或执行 SQL 前读取 [事实表与字段](references/database.md)。
- 创建或更新概览／趋势看板，另读 [字段映射](references/dashboard.md)；调查导入完整性时另读 [导入审计](references/import-audit.md)。
- 网站会话询问每日／今天看板是否生成、执行过程、失败原因、指标及改善建议来源时，先读 [每日看板运行与产物](references/daily-dashboard.md)，通过 `read` 查看已有日志、报告和冻结证据。每日分析 Agent 仍使用当前事务及周期证据，不能读取 `.data`。
- 业务公式、筛选、分类及异常处理以业务规则为准。用户明确改变规则时，仅覆盖指定部分并说明差异。

## 工具选择

读取本入口后启用以下工具，名称均带 `test_oee_calculator__` 前缀：

| 需求 | 工具与参数 |
|---|---|
| 全类型日明细、多日结果 | `get_default_sql(start_date,end_date,view="daily")`，view 可省略 |
| 分类／合并概览或日趋势看板 | `get_default_sql(...,view="overview"/"trends")` |
| 机台日／周／月／季明细 | `get_machine_period_sql(start_date,end_date,grain)`，grain 为 day/week/month/quarter |
| 自定义口径或少量记录抽查 | `get_sql_expressions(source,start_date,end_date,table_alias?)`，source 为 availability/dut |
| 问题指标机台 TOP3 | `rank_machines(start_date,end_date,kind,metric,states?)`，states 仅用于 loss_hours |

SQL 与表达式工具只生成查询或片段，将 SQL 原样交给 `execute_sql`；看板查询使用 `save_as` 保存完整快照。排名工具使用当前会话的只读查询能力执行并保存完整候选快照。

标准状态损失使用公共工具 `measure_loss`，其快照可直接用于后续分析或看板。少量 LOT／分类抽查通过表达式和 SQL VALUES 完成，示例见业务规则。

每日分析引用以返回的 `source` 和 `report_usage` 为准：`measure_loss` 的 `ranking`／`machine_summaries` 仅供调查，其编号不能填入 `machine_evidence_ids`；该字段仅接受同周期、同类型、同入选状态的 `rank_machines` 标准排名编号，并须同时加入 `evidence_ids`。`loss_reference` 始终使用程序提供的 `losses[period].evidence_id` 和入选原始行，不能用补查或排名替换。

## 结果核对

- 说明业务日范围、计算粒度与实际覆盖；缺失和不可计算结果不作为零，部分周期不作为完整周期。
- 明细以 1 表示 100%；看板 `_percent` 列及排名 value/metric_value 已是百分数值，损失为小时。不要重复缩放。
- 更新看板前核对字段前缀、计算样本和覆盖计数，使用完整快照，不复制预览行。
- 具体指标／损失问题或机台集中、分散结论需查询同范围同 MT/ST 的 TOP3，并逐字引用返回的 summary；解释每日归档报告时，可完整读取同运行中成功的排名工具结果，引用原 summary 并注明业务日期和原口径；新分析仍调用排名工具。纯公式解释和单台数值查询无需额外排名。
- 机台展示使用平台号/机台号，映射结果以工具返回的标签为准，无需查询数据库；SQL 键使用原始机台号。排名证据属于派生统计，不能作为实测 loss_reference。
