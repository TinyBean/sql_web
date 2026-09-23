# DataLens：OEE SQLite 数据问答网站

一个使用严格 TypeScript 构建的本地 OEE 数据问答应用。浏览器中的每个会话对应一个持久化 Agent session；Agent 默认提供受限的 Skill 读取、只读 SQLite 查询、当前时间和严格隔离的 Python 代码解释器，Test OEE 等业务能力由 Skill 按会话加载。

## 项目结构

```text
src/
├── client/          # 浏览器端交互、渲染和接口解码
├── server/
│   ├── agent/       # Agent 会话、会话看板状态与模型配置
│   ├── database/    # SQLite 只读查询
│   ├── dashboard/   # 看板注册与快照；default/ 维护默认看板的卡片更新和每日分析 Agent
│   ├── skills/      # 业务技能、规则参考与技能脚本
│   │   └── test-oee-calculator/
│   │       ├── assets/      # 工具定义、计算器与数据库辅助代码
│   │       ├── references/  # 按需读取的数据库结构与业务规则
│   │       └── scripts/     # 可直接执行的 CLI
│   ├── tool/        # Agent 具体工具、产物与代码解释器
│   ├── config.ts    # 环境与运行配置
│   ├── http-server.ts
│   ├── logger.ts
│   └── main.ts      # 服务端入口
└── shared/          # 浏览器端与服务端共享的数据契约
tests/
├── client/          # 浏览器端测试
├── scripts/         # 数据库初始化与数据命令测试
└── server/          # 服务端只读行为测试
public/              # HTML、样式及生成的浏览器脚本
scripts/
├── database/        # 数据库初始化、Schema 与 OEE 写入实现
└── session-to-html.ts  # 持久化会话排障 HTML 导出
```

## 子 Agent 委派

网站对话提供 `subagent` 工具：`{ tasks: [{ name, task }], context? }`，主 Agent 自行决定是否委派 1–3 项独立任务。每日分析则由程序固定并行启动 `week`、`month`、`quarter` 三项任务，全部结束后主 Agent 才开始汇总；每日主 Agent 不提供再次委派工具。结果始终按任务输入顺序返回。

每个子 Agent 使用独立的内存会话，沿用主 Agent 的模型、上下文和输出限制；只接收任务、显式背景与应用提供的看板或每日证据目录，不复制聊天历史。它可独立读取 Skill、查询只读 SQLite、查询标准损失及使用可用的 Python 沙箱计算；不提供继续委派、修改看板、发送邮件或提交每日报告的工具，Python 图片输出也会被拒绝。最终业务动作与 PNG 由主 Agent 完成。

子任务默认最多运行 180 秒、调用 12 次工具，父任务期限更短时服从父任务期限。每日主子 Agent 合计最多调用 60 次工具，自动分派计一次编排调用，参数错误和未知工具也计数，最后 8 次只允许主 Agent 使用。网站点击停止、每日分析超时与服务关闭都会取消关联子任务并等待清理。

结果包含 `agent_id`、`name`、`status`、`text`、`text_truncated`、`error`、`snapshots`、`evidence_ids`、`usage` 和 `duration_ms`。状态为 `completed`、`failed`、`timed_out`、`aborted` 或 `budget_exhausted`；单项失败保留其他结果，主 Agent 不能把未完成输出当作完整结论。每项结论最多返回 12,000 字符，超出时明确标记截断。

网站子任务快照保存在父会话下，使用任务独立的规范名称，主 Agent 可直接读取或用于看板更新。每日主子 Agent 共享同一只读事务和冻结证据登记表；查询、快照落盘与证据登记串行完成，模型请求并行。证据记录 `owner.period` 和 `owner.agentId`：子任务仅可读取该周期的本期、最低点、历史基准及自身补查证据；提示、动态目录和压缩后的上下文均保持这一范围。Python 在解析快照前校验白名单，未知和越权名称统一拒绝且不泄露目录；写入使用任务与周期独立命名空间。日期相同也不自动共享证据。主 Agent 可读全部证据，最终报告仍须按周期引用。

前端沿用一次工具调用记录，子任务明细写入服务端日志，并关联父调用与子任务 ID。每日 `metrics.json` 的 `schemaVersion` 为 2，`agents` 分别记录主子 Agent 指标，顶层 token 汇总所有 Agent；`durationMs` 为实际总耗时，`modelObservedMs` 与 `toolMs` 为可重叠的累计耗时。`toolMs` 排除委派等待，等待时间单独记为 `delegationMs`。新运行的模型阶段为调查、汇总和提交，历史草稿与复核事件仍可统计。子任务不产生网站会话，也不改变 HTTP/SSE、聊天历史或看板的数据格式。

## 默认看板

新会话使用固定的 12 张看板卡片，按以下顺序展示：

1. 四张半宽 OEE 概览：第一排从左到右为 MT Effective OEE、MT Test OEE，第二排为 ST Effective OEE、ST Test OEE。每张上方展示 32px 主百分比，下方以 2×2 仪表盘展示四个组成项；Effective OEE 使用 Effective Availability，Test OEE 使用 Availability，其他组成项均为 Performance (DUT-On)、Performance (Test Time)、Yield。
2. OEE 周趋势、月趋势、季趋势（含最高/最低点，业务周为周日至周六，年初首个周日之前为 W00）。
3. OEE 极值明细、与各极值周期对应的机台 OEE 最低 TOP10 表格。
4. 周、月、季改善措施与责任人清单，每张清单包含 MT/ST 两类。

当前看板是 ID 为 `default` 的看板模块。网站优先读取每日任务生成的 `.data/default-dashboard.json`，无需重新编译或重启；文件缺失或无效时记录日志并使用空数据模板。模板保留 12 张卡片的布局、编码和统计口径，概览指标为 NULL、趋势和表格为空，并提示等待每日更新。模板的业务日期范围为空，`dataAsOf` 记录模板创建时间，不代表已有业务数据；不再内置历史数据。已有有效发布快照仍原样读取。

默认看板按三个职责组织：

- `src/server/dashboard/default/template.ts`：卡片定义及构造函数，集中维护标题、布局、仪表盘、表头和统计口径；`createDefaultDashboard(now)` 可传入固定时间。
- `src/server/dashboard/default/calculate.ts`：`calculateNumericCards(database, throughDate, syncWarnings)` 使用调用方的只读连接，返回 9 张数值卡片，不启动 Agent、不发布文件。
- `src/server/dashboard/default/analysis/index.ts`：准备 3 张改善卡片的周期和覆盖提示，再启动临时 Agent、校验并回填报告；证据隔离、报告校验及审计保留在分析模块内。

`generateDefaultDashboard()` 位于默认看板根目录的 `run.ts`，负责子进程生命周期、超时和降级；`worker.ts` 在同一只读事务中依次生成模板、计算数值、准备分析卡片、发送基础看板、执行 Agent 分析。默认看板的 `update()` 最后校验并原子发布完整看板。

Performance (DUT-On) 为 `SUM(IN_QTY)/SUM(DUT_NUM)`；Performance (Test Time) 按业务日和 MT/ST 分别计算：`TrimmedMean(测试秒数, 0.2)×SUM(TD_Label)/SUM(测试秒数)`。测试秒数是 END_TIME 与 START_TIME 的差；非零有效整数 TOUCHDOWN_INDEX 的 TD_Label 为 1，否则为 NULL。截尾总比例为 0.2%，两端各删除 `floor(n/1000)` 条，仅影响均值；两个总和各自保留全部非空值。小于 1000 条且所有 TD 有效时 Test Time 为 100%。日 OEE 为 Availability×Performance (DUT-On)×Performance (Test Time)×Yield，多日仍等权平均日 OEE；概览五项统一使用该类型 OEE 可计算日。零分母和必要聚合值缺失保持 NULL，不限制结果上限。旧 `performance` 字段仅为 DUT-On 的兼容别名。

Effective Availability = Availability + Idle / (1 + (1 - Idle - Availability))；Effective OEE 复用已有逐日 SQL，以 Effective Availability 替换 Availability。每张 Effective OEE 概览的主值和组成项均对该类型日 Effective OEE 非 NULL 的业务日等权平均，覆盖计数独立于 Test OEE。已有会话继续使用各自保存的看板。每个看板最多允许 14 张卡片，默认 12 张仍留有两个新增位置。

机台 TOP10 表格按周最低、周最高、月最低、月最高、季最低、季最高排序，周期及周期 OEE 直接沿用极值明细，每行展示该周期 OEE 最低的至多 10 台机台。机台 OEE 使用整期汇总：运行秒数÷（该机台有效 Availability 业务日数×86400）×SUM(IN_QTY)÷SUM(DUT_NUM)×[SUM(同日同类型截尾标准秒数×该机台TD次数)÷SUM(该机台实际测试秒数)]×SUM(OUT_QTY)÷SUM(IN_QTY)，区别于周期 OEE 的日类型等权平均。机台 Test Time 复用同日同类型全部合格 DUT 的标准时间，不按机台单独截尾。同一机台的 MT/ST 数据合并，按 Availability 累计时长标注主要类型，并列取 MT；按未舍入 OEE 升序排名，并列按机台编号。查询保留完整周期末日的 DUT 数据，缺失或零分母为 NULL，不参与排名；表格提示各周期的机台数量和数据覆盖情况。

新会话首次展示时锁定当时的默认版本，从 revision 0 开始；首次保存时将其写入该会话的 baseline 和 current，重置会恢复该会话的 baseline。已打开的空会话也保留其初始版本，且仍不创建持久化产物。已有会话可通过对话更新自己的卡片。

MT/ST 概览分别对各自 OEE 可计算业务日的五项指标等权平均，不混合类型，也不将组成项的平均值再次相乘得到 OEE。默认快照只接受当前固定顺序的 12 张卡片；旧九卡、十卡、旧趋势顺序及旧公式快照不再转换，不符合当前格式时记录日志并使用空数据模板，读取不会重算或改写原文件。已有会话仍读取自己的 baseline/current，编辑和重置行为保持不变。

每次模型请求前，应用会将该会话当前展示的完整看板注入 Agent 上下文，包括图表数值、表格文字、日期、统计口径和警告。首次提问、后续提问、工具更新后的继续回答，以及历史会话恢复或上下文压缩后都能读取最新的会话看板。注入内容仅用于模型请求，不追加到聊天记录，也不触发看板重算或空会话产物创建。Agent 可直接解释看板内容；要求最新数据、重新计算或扩展分析时仍需查询工具。看板读取失败时会记录错误，并明确告知 Agent 当前看板不可用。

### 新增看板与用户选择

看板通过 `src/server/dashboard/index.ts` 的 `createDashboardRegistry()` 显式注册，网站和每日任务共用该注册入口。每个 `DashboardDefinition` 提供唯一 `id`、`loadInitial()` 和可选的 `update(context)`；ID 只能包含小写字母、数字、下划线和连字符，以字母开头，最多 64 个字符。重复或未知 ID 会报错，未指定 ID 时选择 `default`。

新增看板时，在独立目录中实现定义并加入注册表。快照使用各自的文件路径，例如 `.data/dashboards/production.json`；`readDashboardSnapshot` / `writeDashboardSnapshot` 提供通用结构校验、大小限制和原子发布，不要求固定卡片数量。初始快照 revision 必须为 0；文件缺失时使用什么兜底内容、额外业务校验及分析产物目录由各模块维护。

以下示例展示每周更新策略；`buildProductionDashboard` 由该看板实现，负责在只读数据库事务中生成完整的 `DashboardState`：

```ts
const productionDashboard: DashboardDefinition = {
  id: "production",
  loadInitial: () => readDashboardSnapshot(snapshotPath),
  async update(context) {
    // 截止业务日为周六时更新，即通常在周日的每日任务中执行。
    const due = new Date(context.throughDate + "T00:00:00Z").getUTCDay() === 6;
    if (!due) {
      return { status: "skipped", published: false, dataAsOf: null, reason: "本周无需更新" };
    }
    const { buildProductionDashboard } = await import("./build.ts");
    const state = await buildProductionDashboard(context);
    writeDashboardSnapshot(snapshotPath, state);
    return { status: "completed", published: true, dataAsOf: state.dataAsOf, reason: null };
  },
};
```

`update(context)` 接收数据库路径、截止业务日、运行时间、同步警告、运行 ID 和日志对象，由看板自行决定更新或返回 `skipped`。各看板维护自己的卡片计算、每日分析 Agent 和发布逻辑，只能只读访问数据库，生成和校验成功后再原子发布。分析或缓存文件使用独立目录，避免相同运行 ID 下相互覆盖。省略 `update` 的看板仅用作初始模板。注册和 `loadInitial()` 不启动更新或 Agent；dry-run 只列出注册信息，不调用 `loadInitial()` 或 `update()`。

会话看板状态由 `src/server/agent/session-dashboard.ts` 维护，使用注入的 `loadInitialDashboard(sessionId)` 获取初始快照。当前服务组装处传入 `() => dashboards.loadInitial()`；后续用户系统可在这里根据会话所属用户的配置调用 `dashboards.loadInitial(dashboardId)`，无需改动卡片编辑、版本冲突或重置逻辑。网站对话 Agent 继续共用，HTTP 契约及历史会话文件格式保持兼容。

## 每日自动更新

手动执行与定时任务使用同一入口：

```bash
npm run data:daily -- --dry-run
npm run data:daily
npm run data:daily -- --through-date 2026-09-14
```

业务日为上海时间当天 08:30 至次日 08:30。任务在 08:30 后默认同步到昨天，之前同步到前天；显式截止日期也必须是已结束的业务日。`--dry-run` 仅显示数据库路径、同步请求和已注册看板的 `dashboardId`、`hasUpdate`（是否配置更新入口），不预测看板是否跳过，不访问 API，也不创建日志、锁或数据库文件。

任务串行同步 Availability 和 DUT，复用现有补缺口、失败窗口重试和最近两天刷新机制。DUT 接口的请求起止日期均比目标业务日期晚一天，两张事实表原始日期保持不变。数据范围覆盖截止业务日所属年份的 1 月 1 日至截止日，以及最近完整周（必要时包含上一年）。

数据库同步范围独立于看板配置，即使没有注册更新策略也照常同步。同步完成并关闭写入连接后，按注册顺序串行执行各看板策略。默认看板每次都更新，在同一个只读 SQLite 事务中重算 12 张卡片。业务周为周日至周六，周编号采用 `%U`，每年首个周日之前为 W00；例如 2026-W36 为 09-06 至 09-12。趋势每年从 1 月 1 日重新开始；最高/最低点排除 NULL，按未舍入值比较，并列取最早期间。改善清单分别对应最近完整周、截止业务日所在月累计和季度累计；最近完整周截至不晚于截止业务日的最近周六，向前覆盖七天。由临时 Agent 结合年内最低点与历史覆盖自主查询、判断并排序，不限制损失类别。顶层日期范围是年内趋势范围；部分周期、缺日和最新业务日未就绪会显示提示。已保存的历史会话和快照保留原日期与口径，新生成的周指标使用新定义。

两个接口均成功时，即使数据缺失也继续执行看板更新并传递同步警告；默认看板发布已有结果，缺失指标保留 NULL。任何接口硬失败都会跳过全部看板，已完成的数据库导入仍保留审计记录。单个看板的计算、验证或写入失败会保留其旧快照并继续更新后续看板，已发布的其他看板不回滚；每个看板的全部卡片一次性原子发布。

每日调度由 `scripts/scheduling/daily-update.ts` 维护。命令结果包含总体 `status`、`throughDate`、`database` 同步结果和按注册顺序排列的 `dashboards` 结果，每项记录 `dashboardId`、`status`、`published`、`dataAsOf`、`reason` 及模块详情 `details`。存在任何硬失败时退出 `1`，否则有警告时退出 `2`，其余退出 `0`；正常跳过不计为警告。CLI 不再重复输出默认看板的顶层 `published`、`dataAsOf` 和分析字段；消费者应在 `dashboards` 中按 `dashboardId` 读取。dry-run 也不再输出默认看板路径和周期详情。

### 临时 Agent 改善分析

指标生成与 Agent 查询在独立子进程的同一个只读 SQLite 事务内运行。子进程先交回基础指标，再使用内存会话和设置、项目 `.data/agent` 的模型凭据启动分析；模型沿用 `SQL_WEB_PROVIDER` / `SQL_WEB_MODEL`（当前为 `local-vllm / zai-org/GLM-5.3-Flash`）。不产生网站会话。

分析分别覆盖最近完整周、当月累计、当季累计的 MT/ST，每类型最多三项。保留原六列：**类型、优先级、问题（损失源）、改善措施、建议责任人、本期损失小时**。问题文本包含简要事实和判断；推测需标注待验证，责任人仅为建议职能。Agent 可查询所有状态、机台及 Performance/Yield；损失小时由程序从 `measure_loss` 的本期同类型实测证据取值，Performance/Yield 等无法对应实测时间的问题保持 `null`。

分析正文使用业务用户可读的中文日期、指标和数据来源说明；内部证据编号（如 `q11`）、查询行号、工具名及字段名只用于结构化引用和审计。提交校验发现这些内部标记出现在正文时，要求 Agent 保留事实和统计口径、改写后再提交。

临时 Agent 复用网站的 `execute_sql`、`get_current_time`、`measure_loss` 和可用时的 `code_interpreter`，以及 Skill 目录读取和标准 OEE 规则工具，最终报告通过 `submit_analysis` 提交；最多 60 次调用。每日主 Agent 的 `execute_sql` 和 `measure_loss` 必须填写 `period`（`week`、`month` 或 `quarter`）以标记补查证据归属，子任务周期由服务端绑定，不能指定或修改。所有 SQL 仍使用构建指标的同一次只读事务。查询及损失明细保存为运行独立的冻结快照，`execute_sql` 返回元数据、证据编号和最多 3 行、6 KB 预览。`measure_loss` 对不超过 32 行且展示内容不超过 12 KiB 的结果返回完整行；更大的结果返回 MT/ST 分组的损失合计、状态占比和各自最高十条机台—状态记录，超出展示预算时标明省略。摘要只针对当前筛选范围，覆盖日数不叠加；派生合计不能作为损失小时的行引用，排名保留原始行号。原始证据截断时禁止全量摘要。Python 仍可按逻辑名称读取完整快照；展示省略不代表原始证据截断。同一证据快照不能覆盖，机台明细最多保留 100,000 行、32 MiB，超限查询失败且不保存快照。每日分析按各周期的 start/end 调用统一日期接口；报告只接受标准损失查询来源、日期范围和 MT/ST 类型均匹配的原始行，所有证据引用必须归属报告对应周期，即使日期相同也分别登记。Python 沙箱不可用时，可用聚合 SQL 或缩小损失查询范围继续分析。

自动上下文压缩已启用。每日分析的上下文上限默认 262144 token、单次输出上限默认 32768 token，均不超过模型目录上限；用 `SQL_WEB_DAILY_ANALYSIS_CONTEXT_WINDOW` 按实际部署容量调整、`SQL_WEB_DAILY_ANALYSIS_MAX_OUTPUT_TOKENS` 调整输出上限。输出还最多占上下文四分之一，提前为系统指令、工具和证据目录预留空间。压缩后保留系统中的口径与比较基准，每次请求重新提供权限范围内的快照目录和工具额度，主 Agent 还会收到服务端保存的三期子任务结果与状态；完整证据和校验在服务端独立保存。模型将报告数组序列化成 JSON 字符串时会先规范化再严格校验，错误反馈不会重复回显整个报告。

`SQL_WEB_DAILY_ANALYSIS_TIMEOUT_MS` 默认 600000（10 分钟）。报告必须包含三期及每期 MT/ST，校验最低点/历史/本期引用、证据周期归属、优先级、业务正文和损失证据；`submit_analysis` 验证成功即接受并结束分析，不产生草稿，也没有复核、修改合并或再次确认步骤。报告不再包含 `verification`，不再提供 `get_analysis_draft` 和 `finalize_analysis`。字段或证据错误返回模型修正重交；模型只输出正文而未提交时，最多追加两次补救提示。

子任务失败、超时、额度耗尽、输出截断或证据不足时，主 Agent 在剩余时间与工具额度内补查该周期。成功周期直接用于汇总；仍须提交完整三期才接受，未能补齐则沿用整体分析不可用的降级行为。

模型不可用、超时或未提交有效报告时，仍发布最新指标，清空三张改善清单并显示“本次分析暂不可用”，退出码为 `2`；同步硬失败、指标计算失败或发布失败为 `1`。空数据模板不附带固定改善建议，已保存的历史会话不受影响。`--dry-run` 不创建 Agent。

每次运行在 `.data/daily-analysis/<运行 ID>/` 保存 `run.json`（模型、状态、耗时、失败原因）、`base-dashboard.json`、`context.json`、`evidence.jsonl`（SQL、参数、完整结果、证据 ID、周期与任务归属和快照描述）、`analysis-data/`（快照及目录）、`events.jsonl`（含实际 token 预算、沙箱状态、轮次和工具 ID、工具耗时、子任务结果、最终接受报告及压缩事件）、`metrics.json`（分阶段耗时、token、错误、重试及超时未完成区间）和有效的 `report.json`。模型耗时为客户端观测的等待与生成区间，可能包括重试和压缩，不代表服务端纯推理时间。默认看板结果的 `details` 包含 `analysisStatus`、`analysisReason`、`analysisRunId` 和 `analysisArtifactDir`；运行 ID 与每日日志关联。证据可能包含业务明细，目录及文件仅供当前用户读写。

分析性能对照使用独立的旧版工作目录和一致数据库备份，不同步数据、不发布看板、不创建网站会话：

```bash
node --import tsx scripts/benchmark-daily-analysis.ts \
  --baseline-root /tmp/sql-web-baseline \
  --output-dir .data/analysis-benchmark/comparison \
  --through-date 2026-09-16 --pairs 3
```

旧版目录需包含原版本源码及可用依赖。对照脚本调用旧版的 `analysis/run.ts` 中的 `generateAnalyzedDashboard()`，当前版调用默认看板根目录 `run.ts` 中的 `generateDefaultDashboard()`。脚本使用当前项目的同一模型配置和凭据，通过 SQLite backup 创建数据库副本；也可用 `--snapshot /path/to/backup.sqlite` 指定已有一致备份。按“旧/新、新/旧、旧/新”顺序串行运行，保存完整报告、证据、`evaluation.json` 和 `summary.json`。性能只比较成功运行的中位数，旧版成功不足两次时不认定提速目标；质量评审单独记录，不能仅凭耗时结果认定通过。评审核对关键数值、机台、日期和措施依据，以及旧版多次出现的有效高优先级问题是否得到保留或有证据的排除。

安装当前项目的每日 09:00 定时任务：

```bash
npm run schedule:install -- --dry-run
npm run schedule:install
crontab -l
```

安装程序检查主机时区为 `Asia/Shanghai`、`cron.service` 已运行及依赖可用；保存当前项目和 Node 的绝对路径，在当前用户 crontab 中维护独立标记的 `0 9 * * *` 条目，重复安装不会增加任务，也不会覆盖其他条目。定时任务每天运行一次；主机离线时错过的日期由下次同步补齐。

手动和定时入口使用 `flock` 锁住整个流程，重叠调用输出 skipped 并退出。任务读取项目 `.env`，配置规则与现有数据命令一致。结构化日志位于 `.data/logs/oee-daily-YYYY-MM-DD.log`，包含同步审计、目标日期、缺失范围、发布结果和耗时；cron 启动输出另存为 `oee-daily-console-YYYY-MM-DD.log`。日志日期均为上海时间，凭据不写入任务条目。

## 数据链路

```text
OEE HTTP API / 本地 JSON
          │
          ▼
   OeeDataStore
   ├─ 流式下载与解析
   ├─ 必填字段校验
   └─ API 原始行逐条追加
          │
          ▼
   .data/database/oee.sqlite
   ├─ oee_availability
   ├─ oee_dut_utilization
   ├─ oee_import_runs
   └─ oee_import_windows
          │
          ▼
       Agent 问答
```

OEE API 默认地址：

- `R_OEE_MT_TOP_AVAILABILITY_2W`
- `R_OEE_MT_TOP_DUT_UTILIZATION_2W`

参数使用 `pSTARTDAY=YYYYMMDD&pENDDAY=YYYYMMDD`。开始和结束日期均包含在查询范围内，单次 API 拉取最多 3 个自然日。`data:sync` 会自动将更长范围拆成最多 3 天的串行请求。如果 API 要求 HTTP Basic 鉴权，在 `.env` 中同时配置 `API_USER` 和 `API_PWD`；鉴权信息只会通过请求头发送，不会写入 URL 或日志。

DUT 接口返回的 UTC `DATE` 比请求业务日期早一天；增量同步规划会应用这一固定偏移，但事实表始终保存接口返回的原始 `DATE`，不会改写或裁剪记录。

## 数据完整性

每次导入都会获得任务 ID 和窗口 ID。命令结果、审计表和 JSON Lines 日志会共同记录：

- 请求的开始、结束日期。
- 响应实际包含的最小、最大日期。
- 接收、新增和替换删除的行数。
- 每日行数、缺失日期、越界日期和无法归属日期的行数。
- 当前数据库的最小日期、最大日期、总行数和日期数。
- 原始响应 SHA-256。

Availability 和 DUT 两个事实表都使用自增 `id` 作为主键。导入窗口在一个事务中处理：对于响应实际返回且位于预期范围内的日期，先删除该日期旧数据，再逐条保存本次响应，因此重复导入正常日期不会累积旧批次；同一响应内部的完全重复行仍会全部保留。解析、必填字段校验或数据库写入失败会回滚整个窗口。

响应缺少预期日期时不会删除该日期已有数据，窗口状态为 `completed_with_warnings`。DUT 的无日期、无效日期或越界日期行仍会保存并记录异常，但因为事实表不保存窗口 ID，这些异常行在重复导入时可能累积，必须结合 `data:status` 人工判断。

Availability 的 `tool_name`、`lot_id`、`final_state`、`step`、`date`、`time_span` 为非空字段，`shift` 允许为空。DUT 的 `machine_id`、`lot_id`、`in_qty`、`out_qty`、`test_stage`、`dut_num`、`step_id` 为非空字段，其他源字段允许为空且暂不校验。DUT 长字段直接保存在事实表中。

数据库保留两张事实表和两张导入审计表。`oee_import_runs` 记录一次命令任务，`oee_import_windows` 记录每个最多三天的下载/导入窗口及其状态。SQLite 因 `AUTOINCREMENT` 自动维护的 `sqlite_sequence` 不属于业务表。事实覆盖仍可直接查询：

```sql
SELECT MIN(substr(date, 1, 10)), MAX(substr(date, 1, 10)), COUNT(*)
FROM oee_availability;
```

## 数据命令

首次部署时显式创建数据库并执行 Schema。该命令也用于把旧数据库升级到当前 Schema 版本，可以安全重复运行且不会清空已有事实或审计数据：

```bash
npm run data:init
```

其余数据命令只打开已经初始化的数据库；数据库不存在或未初始化时会直接失败。

导入已经下载的 JSON：

```bash
npm run data:import -- availability .data/availability.json 2026-08-20 2026-08-30
npm run data:import -- dut_utilization .data/dut.json 2026-08-20 2026-08-30
```

直接拉取并导入一个窗口：

```bash
npm run data:pull -- availability 2026-08-20 2026-08-22
npm run data:pull -- dut_utilization 2026-08-20 2026-08-22
```

根据审计状态同步到指定日期。命令会自动补齐失败、中断、未覆盖和新增日期，并刷新最近两天：

```bash
npm run data:sync -- all 2026-09-02
```

空数据库首次同步或现有数据库历史回填时，提供明确的起始日期：

```bash
npm run data:sync -- all 2026-09-02 2026-08-20
```

例如，在保留现有数据的前提下回填 2026 年 1 月 1 日至 9 月 2 日的两个数据集：

```bash
npm run data:sync -- all 2026-09-02 2026-01-01
```

显式提供起始日期时，同步会在该范围内跳过已完成的历史窗口，只补缺口并保留最近两天刷新。单个窗口失败不会阻止其他窗口和另一个数据集继续执行；下次运行会自动重试失败或中断范围。

强制重新拉取并原子替换指定日期范围：

```bash
npm run data:reimport -- availability 2026-08-20 2026-08-30
npm run data:reimport -- dut_utilization 2026-08-20 2026-08-30
```

较长范围会自动拆成最多三天的窗口。重导成功会关闭相同逻辑日期上的旧异常建议，但不会自动清理无法按日期归属的 DUT 异常行。

查看状态：

```bash
npm run data:status
```

`data:status` 为每个数据集输出四组 JSON：`facts` 是事实日期范围、行数、缺口和无日期行数；`tracking` 是审计覆盖、连续完成日期、下一起始日期和最新任务；`issues` 是当前有效异常；`recommendations` 给出结构化的 `sync` 或 `reimport` 建议。

生产环境可定期执行 `data:sync`。正常完成返回 0，已提交但存在缺日/越界/无日期异常返回 2，硬失败返回 1，可由 cron、systemd timer 或调度平台分别告警。旧事实数据没有审计历史时会显示 `legacy_untracked`，应使用显式起始日期同步或 `data:reimport` 建立可信覆盖。

数据拉取、重试、导入和同步结果按上海自然日写入 `.data/logs/oee-data-YYYY-MM-DD.log`；网站服务日志写入 `.data/logs/sql_web-YYYY-MM-DD.log`。两类日志的时间戳均使用上海时区（`+08:00`），不会由应用自动删除。

服务日志使用 `serviceRunId` 串联一次进程生命周期，并记录配置、数据库、产物目录、代码解释器、Agent Store、HTTP 监听、信号和关闭阶段。每个 API 响应返回 `X-Request-Id`；网页错误也会展示该跟踪 ID。数据日志使用 `commandRunId`、`importRunId` 和 `windowId` 与审计表关联。日志不会写入鉴权头、密码、请求正文或原始数据行。

## 会话排障导出

将持久化 session 导出成可直接用浏览器打开的单文件 HTML：

```bash
# 使用完整 session ID
npm run session:html -- 01a07997-d9c6-71e7-8218-a3131cea47ed

# 使用 JSONL 路径并指定输出文件
npm run session:html -- .data/sessions/example.jsonl /tmp/session.html

# 导出最近修改的 session
npm run session:html -- latest
```

未指定输出路径时，文件写入 `.data/session-exports/<session-file>.html`。脚本默认从 `SQL_WEB_SESSION_DIR` 查找 ID；也可以使用 `--session-dir <directory>` 指定其他目录。导出过程只读取原 JSONL 快照，不会迁移或改写 session。

HTML 默认为完整诊断视图，可切换分支、搜索条目，并展示持久化 header、消息、thinking、工具参数及原始结果、usage、错误、模型切换、压缩/分支记录、自定义条目和代码解释器图片；也可以切换为简化的对话视图。页面的 CSS、JavaScript、Markdown 渲染器、清理器和图片都内嵌在文件中，不依赖正在运行的网站或网络资源。

该导出是排障资料，不是脱敏的分享页面。文件可能包含用户问题、内部 thinking、SQL、查询结果、Python 代码、本机路径和生成图片；默认以仅当前用户可读写的权限创建，仍应按敏感数据保管。

## 表结构

数据库中的四张用户表：

- `oee_availability`：Availability 原始事实数据，自增 `id` 主键加七个源字段。
- `oee_dut_utilization`：DUT 原始事实数据，自增 `id` 主键加 37 个源字段（包括长位图字段）。
- `oee_import_runs`：导入命令任务、参数、生命周期状态、窗口汇总和首个错误。
- `oee_import_windows`：数据集窗口、请求/预期日期、下载与导入状态、行数、哈希和异常详情。

## 启动

环境要求：Node.js 22.19 或更高版本，以及 Linux x86_64 上的 Python 3.12、bubblewrap、prlimit、NumPy、SciPy、Matplotlib 和 Pillow。代码解释器依赖自检失败时网站仍可启动，Skill catalog、SQL 和当前时间工具仍然可用。

```bash
npm install
cp .env.example .env
npm run data:init
npm start
```

后台启动

```bash
npm run build && setsid -f node --enable-source-maps dist/src/server/main.js >> nohup.out 2>&1 < /dev/null
```

打开 <http://127.0.0.1:3000>。

开发和验证：

```bash
npm run dev
npm run check
npm test
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `3000` | HTTP 端口 |
| `SQL_WEB_DB_PATH` | `.data/database/oee.sqlite` | SQLite 文件位置 |
| `SQL_WEB_SESSION_DIR` | `.data/sessions` | Agent session 目录 |
| `SQL_WEB_ARTIFACT_DIR` | `.data/artifacts` | 会话级数据快照及历史会话产物目录 |
| `SQL_WEB_DAILY_ANALYSIS_TIMEOUT_MS` | `600000` | 临时 Agent 分析时限（毫秒），基础指标计算另有同长度的超时保护 |
| `SQL_WEB_DAILY_ANALYSIS_CONTEXT_WINDOW` | `262144` | 每日分析的部署上下文上限，取它与模型目录上限的较小值 |
| `SQL_WEB_DAILY_ANALYSIS_MAX_OUTPUT_TOKENS` | `32768` | 每日分析单次输出上限，另受模型及上下文四分之一限制 |
| `SQL_WEB_DEFAULT_DASHBOARD_PATH` | `.data/default-dashboard.json` | 每日生成的默认看板；网站和数据命令须使用相同路径 |
| `SQL_WEB_PYTHON_PATH` | `/usr/bin/python3` | 代码解释器使用的 Python |
| `SQL_WEB_BWRAP_PATH` | `/usr/bin/bwrap` | bubblewrap 可执行文件 |
| `SQL_WEB_PRLIMIT_PATH` | `/usr/bin/prlimit` | 资源限制工具 |
| `OEE_API_BASE_URL` | 内部 OEE 地址 | 数据拉取根地址 |
| `API_USER` | 未配置 | OEE API HTTP Basic 用户名，必须与 `API_PWD` 同时配置 |
| `API_PWD` | 未配置 | OEE API HTTP Basic 密码，必须与 `API_USER` 同时配置 |
| `SQL_WEB_PROVIDER` | 必填 | 模型提供方 |
| `SQL_WEB_MODEL` | 必填 | 模型 ID |
| `SQL_WEB_SMTP_HOST` | 未配置 | 邮件 SMTP 主机；未配置邮件时不注册 `send_email` |
| `SQL_WEB_SMTP_PORT` | `25` | SMTP 端口；使用无需认证的内网中继，支持服务器提供的 STARTTLS |
| `SQL_WEB_MAIL_FROM_ADDRESS` | 未配置 | 固定发件地址，必须与 SMTP 主机和显示名称同时配置 |
| `SQL_WEB_MAIL_FROM_NAME` | 未配置 | 固定发件显示名称 |

服务只从项目内 `.data/agent/` 加载模型配置和凭据，不读取用户主目录中的全局 Pi 配置。

## Agent 邮件工具

聊天 Agent 在用户明确要求发送邮件、且收件邮箱和内容明确时可调用 `send_email`，无需重复确认。只有责任人姓名或职能时先索取邮箱，不猜测地址。工具在新建和恢复的聊天会话中可用，不依赖 Python；每日分析 Agent 不注册此工具。

当前内网配置在项目 `.env` 中填写如下；`.env.example` 提供注释示例，其他部署不配置邮件即可保持关闭。修改后重启网站服务。

```dotenv
SQL_WEB_SMTP_HOST=10.71.68.150
SQL_WEB_SMTP_PORT=25
SQL_WEB_MAIL_FROM_ADDRESS='"JV OEE Agent"@sdsscn.com'
SQL_WEB_MAIL_FROM_NAME=JV OEE Agent
```

外层单引号用于保留邮箱本地部分的双引号和空格。发件地址同时用于邮件头和 SMTP 信封；不设置 `Reply-To`，回复仍发往原发件地址。SMTP 接受发信不代表该地址已有收件邮箱。

工具接口：`send_email({ to: string[], subject: string, text: string, html?: string })`。收件人最多 50 个，数组每项为一个邮箱地址；主题最多 200 字符，每种正文最多 500,000 字符。必须提供纯文本正文，HTML 可用于中文段落、列表及表格，表格中的信息也应写入纯文本版本。HTML 仅保留基础排版及表格，不接受图片、脚本、外部资源或自定义 CSS；工具不支持附件、抄送、收信或覆盖发件配置。

结果包含 `messageId`、`accepted`、`rejected`、`response`、`errorCode` 和 `status`：`accepted` 表示 SMTP 接受全部收件人，`partial` 表示部分接受，`failed` 表示未被接受，`unknown` 表示连接中断或取消后无法确定是否已被接受。SMTP 接受仅表示进入投递流程，实际送达需收件端确认。连接最长等待 10 秒，每次调用总时限 30 秒，取消会关闭本次 SMTP 连接；工具不自动重试，结果未知时应先核实收件情况，部分接受时不要向已接受地址重复发送。

运行日志 `email.completed` 仅记录会话及工具调用 ID、状态、耗时、收件人数和错误代码，不记录邮件正文、收件地址或完整 SMTP 会话。邮件参数和工具结果与其他工具一样保存在会话历史中。未配置时服务正常启动；配置不完整或发件地址无效时启动报错。

## 安全边界

- `execute_sql` 会先审查传入 SQL，只接受一条返回结果集的查询，并使用只读 SQLite 连接；写入、DDL 和修改状态的 `PRAGMA` 会被拒绝。
- `execute_sql` 默认直接返回最多 200 行；需要 Python 计算、统计或绘图时，使用可选 `save_as` 将最多 100,000 行、32 MiB 的完整结果保存为会话级冻结快照，同时只返回元数据和最多 20 行预览。后续通过逻辑名称引用快照，不经过模型搬运完整结果。
- `measure_loss` 在新建和恢复的会话中默认可用，与每日分析共用实现。必填 `start_date`、`end_date` 为业务日闭区间，可选 `states`、`machines`、`by_machine`；标准 LOT、PCIe、MT/ST 和状态规则与每日分析一致。每次成功查询自动保存完整快照，名称为 `loss-YYYYMMDD-YYYYMMDD`，重名追加序号，恢复后继续避免覆盖。返回明细或有展示预算的摘要，快照可直接供 Python 和看板使用；空结果不代表零损失，覆盖天数按类型统计，不随损失筛选缩小。Python 不可用时仍可查询。
- `get_current_time` 返回服务器当前的 UTC 时间、本地时间和时区。
- `test-oee-calculator` 被加载后，当前会话才会注册 SQL 表达式、LOT 校验、MT/ST 分类和 Availability 状态分类工具；这些工具不连接数据库。数据库派生的比率与乘积必须在同一条 SQL 或可信的 `code_interpreter` 调用中完成，纯比率计算器仅保留为规则测试基准。
- 新增 Skill 必须沿用同一目录约定：根目录只放 `SKILL.md` 等元数据，直接执行的脚本放入 `scripts/`，静态资源和代码放入 `assets/`，按需读取的说明文档放入 `references/`。Catalog 只从 `assets/tools.js` 或 `assets/tools.ts` 加载 Skill 专有工具，不兼容根目录 `tools.*`。
- Skill 专有工具使用 `<skill_namespace>__<local_tool_name>` 命名。Catalog 不接收或持有数据库连接；启动时只扫描元数据并调用无参工具工厂进行校验，不会把专有工具注册到全局或暴露给新会话。需要数据的业务 Skill 自主管理只读连接。
- `code_interpreter` 接收 `code`、可选的 `snapshot` 逻辑名称和可选 `user_input`，不接收或执行 SQL。传入快照时，服务端把该会话的完整冻结数据只读挂载为 `input_data.database`，并提供 `snapshot_rows` 作为 `list[dict]` 行对象列表；每行可用 `row["列名"]` 访问，无需也不应再与 `columns` 做 `zip`。`input_data` 同时支持属性和方括号访问。未传快照时 `input_data.database` 为 `None`、`snapshot_rows` 为空，可执行不依赖数据库的纯 Python。`user_input` 单独出现在 `input_data.user`，只用于用户明确提供的参数。快照查询达到 100,000 行或 32 MiB 上限时不会保存，不允许基于截断数据生成结论。
  Python 必须且只能调用一次 `emit_result(...)`；可提交 JSON 值或结构化关键字字段，运行时会补充缺失的 `summary`，并把字符串 `notes` 规范化为数组。结构化结果上限为 64 KiB。`print()` 仅作为调试日志，不能替代 `emit_result`；工具结果同时包含查询行数、字节数、截断状态和用户输入标记。
  每张 Matplotlib/Pillow 图片必须通过 `emit_image(value, reference_name)` 显式提交；名称应具体表达图片含义，归一化后不超过 50 个字符。空格和标点会统一转成小写连字符格式，例如 `2026 OEE / Top 10` 变为 `2026-oee-top-10`；纯数字、纯符号或空名称会被拒绝。未显式提交的 Matplotlib 图不会输出。
  图片使用不含工具调用 UUID 的短引用，例如 `![oee-ranking](/__datalens_generated_image__/ci-oee-ranking)`；同一会话重名时才追加 `-2`、`-3`。图片解析、流式展示和会话恢复只接受这种语义 ID。
  最终正文落库前会复核所有 Markdown 图片；无效地址优先按 Markdown 图片说明与当前回合 `ChatImage.alt` 的精确唯一对应关系修复。重复说明不猜测，也不参与数量兜底；其他唯一候选继续自动纠正，仍有歧义时触发至多一次不可见的模型重写。服务端保留无法确认或重复的原始引用，前端只渲染当前消息缓存中精确匹配且首次出现的图片 ID。
  Matplotlib 已预配置简体中文字体，普通中文标题和坐标文字无需手动指定字体。`matplotlib_chinese_font(...)` 与 `chinese_font(...)` 是沙箱预注入的全局函数而非 Python 模块，不得导入；需要显式字体对象时直接调用，例如 Matplotlib 使用 `fontproperties=matplotlib_chinese_font(12, bold=True)`，Pillow 使用 `font=chinese_font(20, bold=True)`。
- Python 使用 bubblewrap、seccomp 和 prlimit 隔离：无法访问数据库、项目目录、其他会话产物或网络，并限制执行时间、内存、进程和输出大小。
- 数据快照使用简短的规范逻辑名称，并在服务端映射到不可见的内部 UUID 文件；同名快照只在新查询完整成功后原子替换。快照可在同一会话的后续计算、绘图和恢复后继续使用，并随会话删除。
- 基础 system prompt 不包含业务数据库结构或字段含义；这些上下文由 `test-oee-calculator` 的 `references/database.md` 按需提供，数据内容仍必须通过查询工具获取。
- Agent 递归扫描 `src/server/skills` 并按 Pi 标准格式注入 Skill 名称、描述和入口路径；完整 `SKILL.md` 只在 Agent 根据任务按需读取时进入当前会话上下文。`/skill:<name>` 不会被解析为显式 Skill 调用。
- 通用 `read` 只能读取扫描到的 Skill 目录，拒绝目录穿越、Skill 外文件和符号链接逃逸。成功读取准确的 `SKILL.md` 后，专有工具才在该会话及当前分支内激活；其他会话不受影响。
- 代码沙箱只会只读挂载服务端按当前会话和逻辑名称解析的数据快照，以及独立的用户输入 JSON；不接受模型指定的 SQL、宿主路径、artifact URI 或数据正文。
- 日志不记录用户问题正文、工具参数、查询结果或模型回答正文。

应用仍是本地部署形态，不包含用户登录和租户隔离。正式开放给多用户前，应增加鉴权、限流和独立审计。
