import { parseDashboardState, type DashboardState } from "../../../shared/dashboard.ts";

// Based on session 01a0a299-72d4-7826-95ea-f521e796e3fc, revision 19.
// Nonweekly metrics retain the original snapshots for business days through 2026-09-14.
// Weekly trends, extrema, machine rankings and the complete-week range were rebuilt
// on 2026-09-17 using Sunday-Saturday business weeks (%U), from the read-only OEE DB.
// Analysis remains empty until the daily Agent produces a report.
// No source-session files are needed at runtime; opening a dashboard never recalculates it.
const DEFAULT_DASHBOARD: DashboardState = {
  "schemaVersion": 1,
  "revision": 0,
  "dataAsOf": "2026-09-17T02:08:39.697Z",
  "dateRange": {
    "start": "2026-01-01",
    "end": "2026-09-14"
  },
  "widgets": [
    {
      "id": "mt-oee-overview",
      "kind": "overview",
      "title": "MT · OEE 概览",
      "subtitle": "业务日 2026-01-01 至 2026-09-14（每天 08:30 至次日 08:30）",
      "size": "wide",
      "data": [
        {
          "overall_oee_percent": 51.55133290776901,
          "avg_availability_percent": 65.9790042584808,
          "avg_performance_percent": 79.4095365161564,
          "avg_yield_percent": 98.3704577874588
        }
      ],
      "encoding": {
        "value": "overall_oee_percent",
        "label": "Overall OEE",
        "description": "MT 日 OEE 等权平均；覆盖 245/257 个可计算业务日",
        "gauges": [
          {
            "name": "Availability",
            "column": "avg_availability_percent"
          },
          {
            "name": "Performance",
            "column": "avg_performance_percent"
          },
          {
            "name": "Yield",
            "column": "avg_yield_percent"
          }
        ]
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "MT Overall OEE = AVG(MT 日 Test OEE)×100；日 Test OEE = Availability×Performance×Yield。四项指标分别对该类型 OEE 可计算日等权平均；OEE 不由组成项的平均值再次相乘。沿用有效 LOT、PCIe 排除及 MT/ST 分类规则，缺失或零分母保持 NULL。",
      "warnings": [
        "MT 可计算业务日 245/257；缺 Availability 12 天、缺 DUT 12 天；缺失或零分母为 NULL，四项指标仅使用 OEE 可计算日"
      ]
    },
    {
      "id": "st-oee-overview",
      "kind": "overview",
      "title": "ST · OEE 概览",
      "subtitle": "业务日 2026-01-01 至 2026-09-14（每天 08:30 至次日 08:30）",
      "size": "wide",
      "data": [
        {
          "overall_oee_percent": 61.705900449088816,
          "avg_availability_percent": 75.78892046162244,
          "avg_performance_percent": 82.15021201649581,
          "avg_yield_percent": 99.0799770086894
        }
      ],
      "encoding": {
        "value": "overall_oee_percent",
        "label": "Overall OEE",
        "description": "ST 日 OEE 等权平均；覆盖 245/257 个可计算业务日",
        "gauges": [
          {
            "name": "Availability",
            "column": "avg_availability_percent"
          },
          {
            "name": "Performance",
            "column": "avg_performance_percent"
          },
          {
            "name": "Yield",
            "column": "avg_yield_percent"
          }
        ]
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "ST Overall OEE = AVG(ST 日 Test OEE)×100；日 Test OEE = Availability×Performance×Yield。四项指标分别对该类型 OEE 可计算日等权平均；OEE 不由组成项的平均值再次相乘。沿用有效 LOT、PCIe 排除及 MT/ST 分类规则，缺失或零分母保持 NULL。",
      "warnings": [
        "ST 可计算业务日 245/257；缺 Availability 12 天、缺 DUT 12 天；缺失或零分母为 NULL，四项指标仅使用 OEE 可计算日"
      ]
    },
    {
      "id": "oee-trend-weekly-2026",
      "kind": "line",
      "title": "OEE 周趋势（2026 年至今）",
      "subtitle": "2026-01-01 至 2026-09-14 · MT/ST 日 OEE 等权平均",
      "size": "wide",
      "data": [
        {
          "period_label": "2026-W00",
          "oee_percent": 40.46,
          "max_point": null,
          "min_point": 40.46
        },
        {
          "period_label": "2026-W01",
          "oee_percent": 47.13,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W02",
          "oee_percent": 56.91,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W03",
          "oee_percent": 56.32,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W04",
          "oee_percent": 54.84,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W05",
          "oee_percent": 54.98,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W06",
          "oee_percent": 59.47,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W07",
          "oee_percent": 50.96,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W08",
          "oee_percent": 49.72,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W09",
          "oee_percent": 55.54,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W10",
          "oee_percent": 54.17,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W11",
          "oee_percent": 57.45,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W12",
          "oee_percent": 55.41,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W13",
          "oee_percent": 52.73,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W14",
          "oee_percent": 58.73,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W15",
          "oee_percent": 59.44,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W16",
          "oee_percent": 61.41,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W17",
          "oee_percent": 58.82,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W18",
          "oee_percent": 53.55,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W19",
          "oee_percent": 55.2,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W20",
          "oee_percent": 57.51,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W21",
          "oee_percent": 63.72,
          "max_point": 63.72,
          "min_point": null
        },
        {
          "period_label": "2026-W22",
          "oee_percent": 62.94,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W23",
          "oee_percent": 60.55,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W24",
          "oee_percent": 59.11,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W25",
          "oee_percent": 55.64,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W26",
          "oee_percent": 57.39,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W27",
          "oee_percent": 54.64,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W28",
          "oee_percent": 57.79,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W29",
          "oee_percent": 58.38,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W30",
          "oee_percent": 60.96,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W31",
          "oee_percent": 58.91,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W32",
          "oee_percent": 57.84,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W33",
          "oee_percent": 58.64,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W34",
          "oee_percent": 61.06,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W35",
          "oee_percent": 56.76,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W36",
          "oee_percent": 55.61,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W37",
          "oee_percent": 54.05,
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
      "metricDefinition": "按周（周日至周六）聚合可计算的 MT/ST 日 OEE 并等权平均；极值按未舍入值比较，并列取最早期间",
      "warnings": [
        "可计算日类型 490/514；缺 Availability 24 个、缺 DUT 24 个；缺失或零分母结果为 NULL，平均仅使用可计算值",
        "部分周：2026-W00、2026-W37；与完整周期比较时需注意覆盖天数",
        "业务周为周日至周六；周标签采用周日起始的 %U 编号，年初首个周日之前为 W00"
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
          "oee_percent": 63.72,
          "availability_percent": 77.9,
          "performance_percent": 82.25,
          "yield_percent": 99.32,
          "calculable_day_type_count": 14
        },
        {
          "grain": "周",
          "period_label": "2026-W00",
          "point_type": "最低",
          "oee_percent": 40.46,
          "availability_percent": 51.98,
          "performance_percent": 79.65,
          "yield_percent": 98.27,
          "calculable_day_type_count": 6
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
        "周粒度最低点 2026-W00 仅 3 天（01-01~01-03），Availability 为 51.98%；与完整业务周比较时需注意覆盖天数",
        "月粒度最低点 2026-01 同样受月初低 Availability 影响"
      ]
    },
    {
      "id": "mt-st-components-2026",
      "kind": "table",
      "title": "OEE 机台 TOP10（周/月/季）· 极值单项对应",
      "subtitle": "与 OEE 极值明细逐项对应的机台 TOP10 list",
      "size": "wide",
      "data": [
        {
          "grain": "周",
          "point_type": "最低",
          "period_label": "2026-W00",
          "oee_percent": 40.46,
          "top10_machines": "1.ADH069(MT 1.01%)、2.ADH172(ST 3.63%)、3.ADH074(MT 6.79%)、4.ADH190(ST 9.20%)、5.ADH179(ST 10.24%)、6.ADH173(ST 12.53%)、7.ADH180(ST 13.89%)、8.ADH020(MT 13.96%)、9.ADH084(MT 17.87%)、10.ADH016(MT 18.12%)"
        },
        {
          "grain": "周",
          "point_type": "最高",
          "period_label": "2026-W21",
          "oee_percent": 63.72,
          "top10_machines": "1.ADH203(MT 0.84%)、2.ADH005(MT 22.98%)、3.ADH194(ST 25.13%)、4.ADH036(MT 25.63%)、5.ADH162(ST 25.65%)、6.ADH024(MT 31.35%)、7.ADH085(MT 31.45%)、8.ADH071(MT 32.28%)、9.ADH201(MT 32.80%)、10.ADH124(MT 33.63%)"
        },
        {
          "grain": "月",
          "point_type": "最低",
          "period_label": "2026-01",
          "oee_percent": 52.4,
          "top10_machines": "1.ADH153(ST 1.10%)、2.ADH162(ST 6.44%)、3.ADH170(ST 6.72%)、4.ADH005(MT 10.53%)、5.ADH147(ST 14.07%)、6.ADH149(ST 21.54%)、7.ADH109(MT 23.70%)、8.ADH091(MT 25.01%)、9.ADH045(MT 25.13%)、10.ADH101(MT 25.38%)"
        },
        {
          "grain": "月",
          "point_type": "最高",
          "period_label": "2026-08",
          "oee_percent": 59.04,
          "top10_machines": "1.ADH186(ST 10.43%)、2.ADH182(MT 14.79%)、3.ADH125(ST 17.95%)、4.ADH203(MT 20.16%)、5.ADH204(MT 20.79%)、6.ADH108(MT 27.09%)、7.ADH137(MT 28.94%)、8.ADH076(MT 28.96%)、9.ADH179(ST 29.01%)、10.ADH188(ST 31.59%)"
        },
        {
          "grain": "季",
          "point_type": "最低",
          "period_label": "2026-Q1",
          "oee_percent": 54.06,
          "top10_machines": "1.ADH005(MT 15.43%)、2.ADH141(MT 24.62%)、3.ADH109(MT 27.07%)、4.ADH113(ST 27.95%)、5.ADH065(MT 32.89%)、6.ADH047(MT 34.95%)、7.ADH017(MT 35.27%)、8.ADH089(MT 36.27%)、9.ADH101(MT 36.60%)、10.ADH045(MT 36.61%)"
        },
        {
          "grain": "季",
          "point_type": "最高",
          "period_label": "2026-Q2",
          "oee_percent": 58.44,
          "top10_machines": "1.ADH017(MT 25.51%)、2.ADH005(MT 33.39%)、3.ADH203(MT 36.75%)、4.ADH204(MT 37.10%)、5.ADH049(MT 38.26%)、6.ADH162(ST 40.95%)、7.ADH043(MT 41.30%)、8.ADH123(MT 41.88%)、9.ADH023(MT 41.90%)、10.ADH053(MT 41.93%)"
        }
      ],
      "encoding": {
        "columns": [
          {
            "key": "grain",
            "label": "粒度"
          },
          {
            "key": "point_type",
            "label": "极值"
          },
          {
            "key": "period_label",
            "label": "周期"
          },
          {
            "key": "oee_percent",
            "label": "周期OEE%"
          },
          {
            "key": "top10_machines",
            "label": "TOP10 机台（机台 OEE 最低）"
          }
        ]
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "与 OEE 极值明细（周/月/季）逐项对应；周期 OEE 沿用日类型等权平均。机台 OEE 按同一周期整期汇总：运行秒数÷（有效 Availability 业务日数×86400）×SUM(IN_QTY)÷SUM(DUT_NUM)×SUM(OUT_QTY)÷SUM(IN_QTY)×100；MT/ST 合并为一台，按 Availability 累计时长标注主要类型，并列取 MT。按未舍入机台 OEE 升序取最低 10 台，并列按机台编号；不足 10 台展示实际数量。年初首周及截至业务日的未完整月、季按实际范围统计，缺日不会补零。",
      "warnings": [
        "周粒度最低点 2026-W00 仅 3 天（01-01~01-03），Availability 为 51.98%；与完整业务周比较时需注意覆盖天数",
        "月粒度最低点 2026-01 同样受月初低 Availability 影响",
        "月 2026-01（2026-01-01 至 2026-01-31）：可计算机台 146/148，展示 10 台；入榜机台 Availability 覆盖 1–21/31 天，DUT 覆盖 1–16/31 天；缺失或零分母为 NULL，不参与排名",
        "月 2026-08（2026-08-01 至 2026-08-31）：可计算机台 150/150，展示 10 台；入榜机台 Availability 覆盖 3–27/31 天，DUT 覆盖 2–29/31 天；缺失或零分母为 NULL，不参与排名",
        "季 2026-Q1（2026-01-01 至 2026-03-31）：可计算机台 149/149，展示 10 台；入榜机台 Availability 覆盖 25–82/90 天，DUT 覆盖 20–75/90 天；缺失或零分母为 NULL，不参与排名",
        "季 2026-Q2（2026-04-01 至 2026-06-30）：可计算机台 151/151，展示 10 台；入榜机台 Availability 覆盖 35–86/91 天，DUT 覆盖 28–88/91 天；缺失或零分母为 NULL，不参与排名",
        "周 2026-W00（2026-01-01 至 2026-01-03）：可计算机台 93/101，展示 10 台；入榜机台 Availability 覆盖 1–3/3 天，DUT 覆盖 1–3/3 天；缺失或零分母为 NULL，不参与排名",
        "周 2026-W21（2026-05-24 至 2026-05-30）：可计算机台 149/149，展示 10 台；入榜机台 Availability 覆盖 1–7/7 天，DUT 覆盖 1–7/7 天；缺失或零分母为 NULL，不参与排名"
      ]
    },
    {
      "id": "improvement-actions-week-2026",
      "kind": "table",
      "title": "改善措施与责任人 · 周（2026-W36）",
      "subtitle": "最近完整周 · 2026-09-06 至 2026-09-12 · 临时 Agent 分析",
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
      "metricDefinition": "2026-09-06 至 2026-09-12 的问题、优先级、措施与责任职能由临时 Agent 根据查询证据生成；损失小时仅引用本期实测记录，无法直接量化时为 NULL",
      "warnings": [
        "本次分析暂不可用：尚未生成临时 Agent 报告",
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
