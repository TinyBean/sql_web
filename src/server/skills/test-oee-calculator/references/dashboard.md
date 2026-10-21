# OEE 看板字段映射

使用 `get_default_sql(view: "overview" | "trends")`，将 SQL 原样交给 `execute_sql.save_as` 保存完整快照，基于快照计算或提取最终数据后，通过 `update_dashboard(data={columns,rows}, widget=...)` 更新看板，工具会校验展示数据和图表映射。聚合公式见 [业务规则](business-rules.md)。所有 `_percent` 列已乘 100，`unit: "%"` 只追加单位。

指标须以已保存的完整快照为依据。`preview.truncated=false` 时可直接使用完整预览构造 data；预览截断时使用 `code_interpreter(snapshot)` 从完整快照计算或提取，或重新聚合、筛选并保存完整可见的新结果。不得将局部预览当成完整展示数据或抄入 Python。data 保留原始数值精度和 null，不需要 rowCount、truncated、版本或文件信息；支持原生对象及 JSON 字符串。

### 多看板读写

当前会话看板以应用上下文中的 `dashboards` 列表为准，每项包含 `id`、`title` 和完整 `state`。`activeDashboardId` 是发送本次问题时选中的看板；用户未指定名称时，以它为默认目标，回答期间页面切换标签不会改变此值。

先调用 `get_dashboard` 读取目标 revision 和卡片。省略 `dashboard_ids` 返回全部绑定看板摘要；传 `dashboard_ids: ["overview", "default"]` 可筛选多个看板，`include_data: true` 返回完整卡片数据。概览看板 ID 为 `overview`，操作必须使用该会话实际返回的 ID。

每次 `update_dashboard` 必须传入一个 `dashboard_id`，并使用该看板最近读取的 `base_revision`；同时修改多个看板须分别调用。各看板的卡片、revision 和重置基线彼此独立，同名卡片不会联动。只能修改当前会话已有看板，不得创建未绑定看板。同一快照计算得到的数据可提交到多个看板。upsert 的 dataAsOf 为服务器生成本次看板数据的时间，不代表数据库的实时更新时间。

### 概览字段映射与核对

`get_default_sql(view: "overview")` 返回一行，保存快照后可将完整结果作为 data 提交给多张概览卡片。该行同时包含合并指标和分类指标，按以下映射选择字段：

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

`trends` 提供 `{mt|st}_idle_percent`、`{mt|st}_effective_availability_percent` 和 `{mt|st}_effective_oee_percent`；逐日 Idle 和 Effective Availability 展示其自身可计算值，不因缺少 DUT 隐藏，日 Effective OEE 仍要求所有乘积组成项有效。所有 `_percent` 值已乘 100。缺少新增字段的历史快照需要重新查询，不能补零；历史快照保留原结果；需要新增字段时重新查询。
