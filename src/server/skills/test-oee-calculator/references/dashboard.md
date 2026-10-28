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

四个组成项分别写入 `encoding.gauges[].column`。分类与合并指标均为所选区间池化结果：各来源独立累计，Test Time 在整个周期同类型内重算截尾标准，OEE 为组成项乘积。`avg_*` 仅保留历史字段名，不再表示平均值。不能将分类 OEE 搭配合并 `avg_*` 系数。

分类覆盖使用同类型前缀，以下 `{type}` 为 `mt` 或 `st`：

| 字段 | 含义 |
|---|---|
| `{type}_calculable_day_count` | 该类型日 OEE 非 NULL 的业务日数，仅描述覆盖，不筛选周期计算样本 |
| `{type}_selected_day_count` | 所选闭区间的业务日数，包含无数据日 |
| `{type}_availability_day_count` | 该类型有有效 Availability 记录的业务日数，包含全为 loss 的日 |
| `{type}_dut_day_count` | 该类型有 DUT 记录的业务日数（包含 DUT-only 日期），包含因零分母而 OEE 不可计算的日 |

合并覆盖沿用 `calculable_day_type_count`、`selected_day_type_count`、`availability_day_type_count`、`dut_day_type_count`，单位为日类型，不能除以二推算某一类型的覆盖。

提交 `update_dashboard` 前核对字段映射、日期、分类覆盖和卡片标题、说明一致。仅修改标题或 OEE 字段不会自动筛选四个系数。旧快照缺少分类字段时，用当前工具重新生成 SQL 并执行保存，不从合并均值补齐。

OEE 为 `周期 Availability × 周期 DUT-On × 周期 Test Time × 周期 Yield`；五项百分数字段均已乘100，核对乘积时先把组成项恢复为比率。MT/ST 系数可能真实相同，不能仅按数值相同判错。周/月/季趋势使用 `get_period_sql` 的 ALL 行；MT/ST 行用于分类趋势。周期覆盖不足不补零、不外推。

### Effective OEE 概览字段映射

同一 `overview` 快照同时提供 Effective OEE。Test OEE 与 Effective OEE 共用相同的独立来源累计量。Effective OEE 的主值分别使用 `mt_effective_oee_percent`、`st_effective_oee_percent` 和合并的 `overall_effective_oee_percent`。

以下 `{p}` 为 `mt`、`st` 或合并的 `avg`，同一卡片必须保持前缀一致：

| 指标 | 字段 |
|---|---|
| Idle | `{p}_idle_percent` |
| Effective Availability | `{p}_effective_availability_percent` |
| Performance (DUT-On) | `{p}_effective_dut_on_percent`（恒为89.5） |
| Performance (Test Time) | `{p}_effective_test_time_percent` |
| Yield | `{p}_effective_yield_percent` |

四个乘积组成项映射到 `encoding.gauges[].column`；Idle 保留原始状态包含 IDLE 的总空闲占比，作为辅助指标，不额外乘入 OEE。Effective Availability 使用 `Availability + IDLENoWIP / (1 + (1 - IDLENoWIP - Availability))`，其中 IDLENoWIP 为派生状态 IDLE_NoWIP 的秒数占全部状态秒数的比率，不能用总 Idle 替代。可查询日明细的 `idle_no_wip_seconds` 和 `idle_no_wip` 核对组成项。以上概览字段均按对应类型或合并范围独立池化，不受日 Effective OEE 是否可计算影响。Effective Availability 先由周期状态占比计算；Effective OEE 的 DUT-On 固定89.5%（原始比率 effective_dut_on=0.895），在日/周/月/季/任意区间、MT/ST/合并及机台均相同，即使无数据也展示这个固定配置。Test Time 和 Yield 与同范围 Test OEE 共用池化结果。Actual DUT-On 仍用于 Test OEE，不要将实际 dut_on 字段映射到 Effective OEE 仪表。

分类覆盖使用 `{mt|st}_effective_calculable_day_count`，合并覆盖使用 `effective_calculable_day_type_count`。日期、Availability 和 DUT 覆盖计数复用原字段。Effective Availability 分母为零可能减少 Effective OEE 覆盖；实际 Socket 分母为零只影响 Test OEE，Effective OEE 可计算日数可能更多。覆盖不足须明确说明。

`trends` 额外提供恒为89.5的 `{mt|st}_effective_dut_on_percent`，并提供 `{mt|st}_idle_percent`、`{mt|st}_effective_availability_percent` 和 `{mt|st}_effective_oee_percent`；逐日 Idle 和 Effective Availability 展示其自身可计算值，不因缺少 DUT 隐藏，日 Effective OEE 仍要求所有乘积组成项有效。所有 `_percent` 值已乘 100。缺少新增字段的历史快照需要重新查询，不能补零；历史快照保留原结果；需要新增字段时重新查询。

### 周期接口与历史结果

`get_period_sql(start_date,end_date,grain)` 返回 MT、ST、ALL 的长表，grain 为 day/week/month/quarter；`period_label/period_start/period_end/is_partial_period` 标识所选范围内的实际周期。比率为原始值，展示时乘100；coverage 的 *_day_type_count 在 ALL 为日类型数，在 MT/ST 为本类型天数。`get_default_sql` 三种视图和字段名保留，计算元数据标注 pooled_components。已有会话和每日归档快照保留原值及原口径，不自动重算。
