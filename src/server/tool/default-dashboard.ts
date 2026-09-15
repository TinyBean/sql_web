import { parseDashboardState, type DashboardState } from "../../shared/dashboard.ts";

// Frozen from session 01a0a299-72d4-7826-95ea-f521e796e3fc, revision 19:
// .data/sessions/2026-09-15T01-06-00-532Z_01a0a299-72d4-7826-95ea-f521e796e3fc.jsonl
// Preserve its card order, sizes, data, labels, warnings, and original timestamps.
// Only the revision starts over for a new session. No source-session files are
// needed at runtime, and opening the dashboard never refreshes these snapshots.
const DEFAULT_DASHBOARD: DashboardState = {
  "schemaVersion": 1,
  "revision": 0,
  "dataAsOf": "2026-09-15T02:03:34.568Z",
  "dateRange": {
    "start": "2026-07-01",
    "end": "2026-09-14"
  },
  "widgets": [
    {
      "id": "overall-oee-overview",
      "kind": "overview",
      "title": "Overall OEE",
      "subtitle": "业务日 2026-01-01 至 2026-09-14（每天 08:30 至次日 08:30）",
      "size": "wide",
      "data": [
        {
          "overall_oee_percent": 56.676983039421856,
          "mt_oee_percent": 51.484914842176266,
          "st_oee_percent": 61.869051236667474,
          "avg_availability_percent": 70.91631466869268,
          "avg_performance_percent": 80.7730309103925,
          "avg_yield_percent": 98.74551059147475
        }
      ],
      "encoding": {
        "value": "overall_oee_percent",
        "label": "2026 年 Overall Test OEE（01-01 至 09-14）",
        "description": "MT/ST 日 OEE 等权平均；覆盖 484/514 个可计算日类型",
        "gauges": [
          {
            "name": "MT OEE",
            "column": "mt_oee_percent"
          },
          {
            "name": "ST OEE",
            "column": "st_oee_percent"
          },
          {
            "name": "平均 Availability",
            "column": "avg_availability_percent"
          },
          {
            "name": "平均 Performance",
            "column": "avg_performance_percent"
          },
          {
            "name": "平均 Yield",
            "column": "avg_yield_percent"
          }
        ]
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "Overall Test OEE = AVG(MT/ST 日 Test OEE)×100；日 Test OEE = Availability×Performance×Yield；多日为可计算日 OEE 等权平均（非按机台/产量加权）。PCIe 机台（TSPH001-013）已排除；仅统计有效 LOT（P/M/R/A/F/L 开头）",
      "warnings": [
        "514 个日类型中 484 个可计算，30 个因缺 Availability 或 DUT 数据未计入平均",
        "2026-09 为截至 09-14 的部分月数据"
      ]
    },
    {
      "id": "oee-trend-quarterly-2026",
      "kind": "line",
      "title": "OEE 季趋势（2026 年至今）",
      "subtitle": "日 OEE 等权平均，Q3 为截至 09-14 的部分季度",
      "size": "wide",
      "data": [
        {
          "period_label": "2026-Q1",
          "oee_percent": 54.06,
          "max_point": null,
          "min_point": 54.06
        },
        {
          "period_label": "2026-Q2",
          "oee_percent": 58.44,
          "max_point": 58.44,
          "min_point": null
        },
        {
          "period_label": "2026-Q3",
          "oee_percent": 57.95,
          "max_point": null,
          "min_point": null
        }
      ],
      "encoding": {
        "category": "period_label",
        "series": [
          {
            "name": "季 OEE",
            "column": "oee_percent"
          },
          {
            "name": "最高点",
            "column": "max_point"
          },
          {
            "name": "最低点",
            "column": "min_point"
          }
        ]
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "季 OEE = 该季度内可计算的 MT/ST 日 OEE 等权平均×100；最高/最低点仅在可计算季度中取值。最高 2026-Q2（58.44%），最低 2026-Q1（54.06%）",
      "warnings": [
        "Q2、Q3 存在缺数据日类型（Q2 172/182、Q3 132/152 可计算），平均仅覆盖可计算日",
        "Q3 仅含 07-01 至 09-14，为部分季度数据"
      ]
    },
    {
      "id": "oee-trend-monthly-2026",
      "kind": "line",
      "title": "OEE 月趋势（2026 年至今）",
      "subtitle": "日 OEE 等权平均，2026-01 至 2026-09（9 月为部分月）",
      "size": "wide",
      "data": [
        {
          "period_label": "2026-01",
          "oee_percent": 52.4,
          "max_point": null,
          "min_point": 52.4
        },
        {
          "period_label": "2026-02",
          "oee_percent": 53.9,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-03",
          "oee_percent": 55.86,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-04",
          "oee_percent": 58.85,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-05",
          "oee_percent": 57.57,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-06",
          "oee_percent": 58.97,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-07",
          "oee_percent": 57.58,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-08",
          "oee_percent": 59.04,
          "max_point": 59.04,
          "min_point": null
        },
        {
          "period_label": "2026-09",
          "oee_percent": 56.04,
          "max_point": null,
          "min_point": null
        }
      ],
      "encoding": {
        "category": "period_label",
        "series": [
          {
            "name": "月 OEE",
            "column": "oee_percent"
          },
          {
            "name": "最高点",
            "column": "max_point"
          },
          {
            "name": "最低点",
            "column": "min_point"
          }
        ]
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "月 OEE = 该月内可计算的 MT/ST 日 OEE 等权平均×100；最高/最低点仅在可计算月份中取值。最高 2026-08（59.04%），最低 2026-01（52.40%）",
      "warnings": [
        "部分月份存在缺数据日类型（如 4/5/6/7/8/9 月），平均仅覆盖可计算日",
        "2026-09 仅含 09-01 至 09-14，为部分月数据"
      ]
    },
    {
      "id": "oee-trend-weekly-2026",
      "kind": "line",
      "title": "OEE 周趋势（2026 年至今）",
      "subtitle": "日 OEE 等权平均，共 37 个可计算周；W00 为 01-01~01-04 残周",
      "size": "wide",
      "data": [
        {
          "period_label": "2026-W00",
          "oee_percent": 41.42,
          "max_point": null,
          "min_point": 41.42
        },
        {
          "period_label": "2026-W01",
          "oee_percent": 48.18,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W02",
          "oee_percent": 57.51,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W03",
          "oee_percent": 55.77,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W04",
          "oee_percent": 54.42,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W05",
          "oee_percent": 55.9,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W06",
          "oee_percent": 58.91,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W07",
          "oee_percent": 50.97,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W08",
          "oee_percent": 49.76,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W09",
          "oee_percent": 56.2,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W10",
          "oee_percent": 53.97,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W11",
          "oee_percent": 58.62,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W12",
          "oee_percent": 55.22,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W13",
          "oee_percent": 50.63,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W14",
          "oee_percent": 59.54,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W15",
          "oee_percent": 59.23,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W16",
          "oee_percent": 60.81,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W17",
          "oee_percent": 58.34,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W18",
          "oee_percent": 54.36,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W19",
          "oee_percent": 55.35,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W20",
          "oee_percent": 58.22,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W21",
          "oee_percent": 64.47,
          "max_point": 64.47,
          "min_point": null
        },
        {
          "period_label": "2026-W22",
          "oee_percent": 61.95,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W23",
          "oee_percent": 60.95,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W24",
          "oee_percent": 58.54,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W25",
          "oee_percent": 55.19,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W26",
          "oee_percent": 57.45,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W27",
          "oee_percent": 54.74,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W28",
          "oee_percent": 57.95,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W29",
          "oee_percent": 58.83,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W30",
          "oee_percent": 60.9,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W31",
          "oee_percent": 59.04,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W32",
          "oee_percent": 58.09,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W33",
          "oee_percent": 58.56,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W34",
          "oee_percent": 60.71,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W35",
          "oee_percent": 57.52,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W36",
          "oee_percent": 55.06,
          "max_point": null,
          "min_point": null
        }
      ],
      "encoding": {
        "category": "period_label",
        "series": [
          {
            "name": "周 OEE",
            "column": "oee_percent"
          },
          {
            "name": "最高点",
            "column": "max_point"
          },
          {
            "name": "最低点",
            "column": "min_point"
          }
        ]
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "周 OEE = 该周内可计算的 MT/ST 日 OEE 等权平均×100；最高/最低点仅在可计算周中取值（单独系列标记）。最高 2026-W21（05-25~05-31）64.47%，最低 2026-W00（01-01~01-04）41.42%",
      "warnings": [
        "部分周存在缺数据日类型（如 W13 仅 10/14、W14 仅 12/14 可计算），平均仅覆盖可计算日",
        "残周 2026-W37（仅 09-14 一天）无可计算 OEE，未纳入趋势与极值",
        "W00 为仅 4 天的元旦残周，与其他完整周对比时需注意天数差异",
        "周标签采用周一为起始的 %W 编号"
      ]
    },
    {
      "id": "oee-extremes-table-2026",
      "kind": "table",
      "title": "OEE 极值明细（周/月/季）",
      "subtitle": "各粒度 OEE 最高/最低点及其三组成项，用于定位拖累因素",
      "size": "medium",
      "data": [
        {
          "grain": "周",
          "period_label": "2026-W21",
          "point_type": "最高",
          "oee_percent": 64.47,
          "availability_percent": 78.73,
          "performance_percent": 82.37,
          "yield_percent": 99.32,
          "calculable_day_type_count": 14
        },
        {
          "grain": "周",
          "period_label": "2026-W00",
          "point_type": "最低",
          "oee_percent": 41.42,
          "availability_percent": 53,
          "performance_percent": 79.52,
          "yield_percent": 98.4,
          "calculable_day_type_count": 8
        },
        {
          "grain": "月",
          "period_label": "2026-08",
          "point_type": "最高",
          "oee_percent": 59.04,
          "availability_percent": 73.1,
          "performance_percent": 81.88,
          "yield_percent": 98.61,
          "calculable_day_type_count": 54
        },
        {
          "grain": "月",
          "period_label": "2026-01",
          "point_type": "最低",
          "oee_percent": 52.4,
          "availability_percent": 67.76,
          "performance_percent": 78.51,
          "yield_percent": 98.34,
          "calculable_day_type_count": 62
        },
        {
          "grain": "季",
          "period_label": "2026-Q2",
          "point_type": "最高",
          "oee_percent": 58.44,
          "availability_percent": 72.37,
          "performance_percent": 81.51,
          "yield_percent": 98.86,
          "calculable_day_type_count": 172
        },
        {
          "grain": "季",
          "period_label": "2026-Q1",
          "point_type": "最低",
          "oee_percent": 54.06,
          "availability_percent": 68.83,
          "performance_percent": 79.5,
          "yield_percent": 98.66,
          "calculable_day_type_count": 180
        }
      ],
      "encoding": {
        "columns": [
          {
            "key": "grain",
            "label": "粒度"
          },
          {
            "key": "period_label",
            "label": "期间"
          },
          {
            "key": "point_type",
            "label": "类型"
          },
          {
            "key": "oee_percent",
            "label": "OEE %"
          },
          {
            "key": "availability_percent",
            "label": "Availability %"
          },
          {
            "key": "performance_percent",
            "label": "Performance %"
          },
          {
            "key": "yield_percent",
            "label": "Yield %"
          },
          {
            "key": "calculable_day_type_count",
            "label": "可计算日类型数"
          }
        ]
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "周/月/季三个粒度各自 OEE 最高与最低期间及其三组成项（均为该期间可计算日 OEE 等权平均，百分数值）；极值仅在可计算期间内比较",
      "warnings": [
        "周粒度最低点 2026-W00 仅 4 天（01-01~01-04，元旦假期），Availability 仅 53% 为主要拖累",
        "月粒度最低点 2026-01 同样受月初低 Availability 影响"
      ]
    },
    {
      "id": "mt-st-components-2026",
      "kind": "bar",
      "title": "MT/ST 三组成项对比（2026 年至今）",
      "subtitle": "日组成项等权平均，业务日 2026-01-01 至 09-14",
      "size": "wide",
      "data": [
        {
          "kind": "MT",
          "availability_percent": 65.97,
          "performance_percent": 79.31,
          "yield_percent": 98.38
        },
        {
          "kind": "ST",
          "availability_percent": 75.87,
          "performance_percent": 82.24,
          "yield_percent": 99.11
        }
      ],
      "encoding": {
        "category": "kind",
        "series": [
          {
            "name": "Availability",
            "column": "availability_percent"
          },
          {
            "name": "Performance",
            "column": "performance_percent"
          },
          {
            "name": "Yield",
            "column": "yield_percent"
          }
        ],
        "orientation": "vertical"
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "各类型日组成项的等权平均百分数值（仅计可计算日）：Availability = Machine_Running 秒 / (机台数×86400)；Performance = SUM(IN_QTY)/SUM(DUT_NUM)；Yield = SUM(OUT_QTY)/SUM(IN_QTY)。用于解释 ST OEE 61.87% 高于 MT 51.48% 的结构差异",
      "warnings": [
        "MT 与 ST 各有 242/257 个日类型可计算，缺数据日未计入平均",
        "2026-09 为截至 09-14 的部分月数据",
        "本图替代原 7 日组成项趋势（方案 A），与主页面全期口径统一"
      ]
    },
    {
      "id": "improvement-actions-week-2026",
      "kind": "table",
      "title": "改善措施与责任人 · 周（W36）",
      "subtitle": "临时 Agent 分析尚未生成",
      "size": "medium",
      "data": [],
      "encoding": {
        "columns": [
          {
            "key": "kind",
            "label": "类型"
          },
          {
            "key": "priority",
            "label": "优先级"
          },
          {
            "key": "issue",
            "label": "问题（损失源）"
          },
          {
            "key": "measure",
            "label": "改善措施"
          },
          {
            "key": "suggested_owner",
            "label": "建议责任人"
          },
          {
            "key": "loss_hours",
            "label": "本期损失小时"
          }
        ]
      },
      "format": {
        "unit": "",
        "precision": 1
      },
      "metricDefinition": "问题、优先级、改善措施及建议责任职能由每日临时 Agent 根据查询证据生成；无法直接量化的损失小时为 NULL",
      "warnings": [
        "本次分析暂不可用：内置快照未包含临时 Agent 报告",
        "责任人列为职能建议，需管理层确认后指派到人"
      ]
    },
    {
      "id": "improvement-actions-month-2026",
      "kind": "table",
      "title": "改善措施与责任人 · 月（2026-09）",
      "subtitle": "临时 Agent 分析尚未生成",
      "size": "medium",
      "data": [],
      "encoding": {
        "columns": [
          {
            "key": "kind",
            "label": "类型"
          },
          {
            "key": "priority",
            "label": "优先级"
          },
          {
            "key": "issue",
            "label": "问题（损失源）"
          },
          {
            "key": "measure",
            "label": "改善措施"
          },
          {
            "key": "suggested_owner",
            "label": "建议责任人"
          },
          {
            "key": "loss_hours",
            "label": "本期损失小时"
          }
        ]
      },
      "format": {
        "unit": "",
        "precision": 1
      },
      "metricDefinition": "问题、优先级、改善措施及建议责任职能由每日临时 Agent 根据查询证据生成；无法直接量化的损失小时为 NULL",
      "warnings": [
        "本次分析暂不可用：内置快照未包含临时 Agent 报告",
        "责任人列为职能建议，需管理层确认后指派到人"
      ]
    },
    {
      "id": "improvement-actions-quarter-2026",
      "kind": "table",
      "title": "改善措施与责任人 · 季（2026-Q3）",
      "subtitle": "临时 Agent 分析尚未生成",
      "size": "medium",
      "data": [],
      "encoding": {
        "columns": [
          {
            "key": "kind",
            "label": "类型"
          },
          {
            "key": "priority",
            "label": "优先级"
          },
          {
            "key": "issue",
            "label": "问题（损失源）"
          },
          {
            "key": "measure",
            "label": "改善措施"
          },
          {
            "key": "suggested_owner",
            "label": "建议责任人"
          },
          {
            "key": "loss_hours",
            "label": "本期损失小时"
          }
        ]
      },
      "format": {
        "unit": "",
        "precision": 1
      },
      "metricDefinition": "问题、优先级、改善措施及建议责任职能由每日临时 Agent 根据查询证据生成；无法直接量化的损失小时为 NULL",
      "warnings": [
        "本次分析暂不可用：内置快照未包含临时 Agent 报告",
        "责任人列为职能建议，需管理层确认后指派到人"
      ]
    }
  ]
};

export function createDefaultDashboard(): DashboardState {
  // Parsing validates the bundled snapshot and gives each session its own copy.
  return parseDashboardState(DEFAULT_DASHBOARD);
}
