import { parseDashboardState, type DashboardState } from "../../../shared/dashboard.ts";

// Rebuilt from the read-only OEE DB through business day 2026-09-14.
// Test and Effective OEE include both Performance (DUT-On) and Performance (Test Time).
// Analysis remains empty until the daily Agent produces a report.
// Opening a dashboard never recalculates the bundled snapshot.
const DEFAULT_DASHBOARD: DashboardState = {
  "schemaVersion": 1,
  "revision": 0,
  "dataAsOf": "2026-09-21T02:46:31.430Z",
  "dateRange": {
    "start": "2026-01-01",
    "end": "2026-09-14"
  },
  "widgets": [
    {
      "id": "mt-effective-oee-overview",
      "kind": "overview",
      "title": "MT · Effective OEE",
      "subtitle": "业务日 2026-01-01 至 2026-09-14（每天 08:30 至次日 08:30）",
      "size": "medium",
      "data": [
        {
          "overall_effective_oee_percent": 53.03943099524749,
          "avg_effective_availability_percent": 68.17735984017317,
          "avg_effective_dut_on_percent": 79.4095365161564,
          "avg_effective_test_time_percent": 99.57282616924962,
          "avg_effective_yield_percent": 98.3704577874588
        }
      ],
      "encoding": {
        "value": "overall_effective_oee_percent",
        "label": "Effective OEE",
        "description": "MT 日 Effective OEE 等权平均；覆盖 245/257 个可计算业务日",
        "gauges": [
          {
            "name": "Effective Availability",
            "column": "avg_effective_availability_percent"
          },
          {
            "name": "Performance (DUT-On)",
            "column": "avg_effective_dut_on_percent"
          },
          {
            "name": "Performance (Test Time)",
            "column": "avg_effective_test_time_percent"
          },
          {
            "name": "Yield",
            "column": "avg_effective_yield_percent"
          }
        ]
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "MT Effective OEE = AVG(MT 日 Effective OEE)×100；日 Effective OEE = Effective Availability×Performance (DUT-On)×Performance (Test Time)×Yield。Effective Availability = Availability + Idle / (1 + (1 - Idle - Availability))。五项指标分别对该类型 Effective OEE 可计算日等权平均；OEE 不由组成项的平均值再次相乘。沿用有效 LOT、PCIe 排除及 MT/ST 分类规则，缺失或零分母保持 NULL。",
      "warnings": [
        "MT Effective OEE 可计算业务日 245/257；缺 Availability 12 天、缺 DUT 12 天；缺失或零分母为 NULL，五项指标仅使用 Effective OEE 可计算日"
      ]
    },
    {
      "id": "mt-oee-overview",
      "kind": "overview",
      "title": "MT · Test OEE",
      "subtitle": "业务日 2026-01-01 至 2026-09-14（每天 08:30 至次日 08:30）",
      "size": "medium",
      "data": [
        {
          "overall_oee_percent": 51.326714609342936,
          "avg_availability_percent": 65.9790042584808,
          "avg_dut_on_percent": 79.4095365161564,
          "avg_test_time_percent": 99.57282616924962,
          "avg_performance_percent": 79.4095365161564,
          "avg_yield_percent": 98.3704577874588
        }
      ],
      "encoding": {
        "value": "overall_oee_percent",
        "label": "Test OEE",
        "description": "MT 日 OEE 等权平均；覆盖 245/257 个可计算业务日",
        "gauges": [
          {
            "name": "Availability",
            "column": "avg_availability_percent"
          },
          {
            "name": "Performance (DUT-On)",
            "column": "avg_dut_on_percent"
          },
          {
            "name": "Performance (Test Time)",
            "column": "avg_test_time_percent"
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
      "metricDefinition": "MT Test OEE = AVG(MT 日 Test OEE)×100；日 Test OEE = Availability×Performance (DUT-On)×Performance (Test Time)×Yield。五项指标分别对该类型 OEE 可计算日等权平均；OEE 不由组成项的平均值再次相乘。沿用有效 LOT、PCIe 排除及 MT/ST 分类规则，缺失或零分母保持 NULL。",
      "warnings": [
        "MT 可计算业务日 245/257；缺 Availability 12 天、缺 DUT 12 天；缺失或零分母为 NULL，五项指标仅使用 OEE 可计算日"
      ]
    },
    {
      "id": "st-effective-oee-overview",
      "kind": "overview",
      "title": "ST · Effective OEE",
      "subtitle": "业务日 2026-01-01 至 2026-09-14（每天 08:30 至次日 08:30）",
      "size": "medium",
      "data": [
        {
          "overall_effective_oee_percent": 62.27373391488916,
          "avg_effective_availability_percent": 77.63693196142621,
          "avg_effective_dut_on_percent": 82.15021201649581,
          "avg_effective_test_time_percent": 98.5522897465314,
          "avg_effective_yield_percent": 99.0799770086894
        }
      ],
      "encoding": {
        "value": "overall_effective_oee_percent",
        "label": "Effective OEE",
        "description": "ST 日 Effective OEE 等权平均；覆盖 245/257 个可计算业务日",
        "gauges": [
          {
            "name": "Effective Availability",
            "column": "avg_effective_availability_percent"
          },
          {
            "name": "Performance (DUT-On)",
            "column": "avg_effective_dut_on_percent"
          },
          {
            "name": "Performance (Test Time)",
            "column": "avg_effective_test_time_percent"
          },
          {
            "name": "Yield",
            "column": "avg_effective_yield_percent"
          }
        ]
      },
      "format": {
        "unit": "%",
        "precision": 2
      },
      "metricDefinition": "ST Effective OEE = AVG(ST 日 Effective OEE)×100；日 Effective OEE = Effective Availability×Performance (DUT-On)×Performance (Test Time)×Yield。Effective Availability = Availability + Idle / (1 + (1 - Idle - Availability))。五项指标分别对该类型 Effective OEE 可计算日等权平均；OEE 不由组成项的平均值再次相乘。沿用有效 LOT、PCIe 排除及 MT/ST 分类规则，缺失或零分母保持 NULL。",
      "warnings": [
        "ST Effective OEE 可计算业务日 245/257；缺 Availability 12 天、缺 DUT 12 天；缺失或零分母为 NULL，五项指标仅使用 Effective OEE 可计算日"
      ]
    },
    {
      "id": "st-oee-overview",
      "kind": "overview",
      "title": "ST · Test OEE",
      "subtitle": "业务日 2026-01-01 至 2026-09-14（每天 08:30 至次日 08:30）",
      "size": "medium",
      "data": [
        {
          "overall_oee_percent": 60.79130275921476,
          "avg_availability_percent": 75.78892046162244,
          "avg_dut_on_percent": 82.15021201649581,
          "avg_test_time_percent": 98.5522897465314,
          "avg_performance_percent": 82.15021201649581,
          "avg_yield_percent": 99.0799770086894
        }
      ],
      "encoding": {
        "value": "overall_oee_percent",
        "label": "Test OEE",
        "description": "ST 日 OEE 等权平均；覆盖 245/257 个可计算业务日",
        "gauges": [
          {
            "name": "Availability",
            "column": "avg_availability_percent"
          },
          {
            "name": "Performance (DUT-On)",
            "column": "avg_dut_on_percent"
          },
          {
            "name": "Performance (Test Time)",
            "column": "avg_test_time_percent"
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
      "metricDefinition": "ST Test OEE = AVG(ST 日 Test OEE)×100；日 Test OEE = Availability×Performance (DUT-On)×Performance (Test Time)×Yield。五项指标分别对该类型 OEE 可计算日等权平均；OEE 不由组成项的平均值再次相乘。沿用有效 LOT、PCIe 排除及 MT/ST 分类规则，缺失或零分母保持 NULL。",
      "warnings": [
        "ST 可计算业务日 245/257；缺 Availability 12 天、缺 DUT 12 天；缺失或零分母为 NULL，五项指标仅使用 OEE 可计算日"
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
          "oee_percent": 47.06,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W02",
          "oee_percent": 56.74,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W03",
          "oee_percent": 56.23,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W04",
          "oee_percent": 54.63,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W05",
          "oee_percent": 54.8,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W06",
          "oee_percent": 59.38,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W07",
          "oee_percent": 50.94,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W08",
          "oee_percent": 49.59,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W09",
          "oee_percent": 55.25,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W10",
          "oee_percent": 53.46,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W11",
          "oee_percent": 56.54,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W12",
          "oee_percent": 54.72,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W13",
          "oee_percent": 52.01,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W14",
          "oee_percent": 58.23,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W15",
          "oee_percent": 58.57,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W16",
          "oee_percent": 60.6,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W17",
          "oee_percent": 58.3,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W18",
          "oee_percent": 52.87,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W19",
          "oee_percent": 54.52,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W20",
          "oee_percent": 56.7,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W21",
          "oee_percent": 62.95,
          "max_point": 62.95,
          "min_point": null
        },
        {
          "period_label": "2026-W22",
          "oee_percent": 62.2,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W23",
          "oee_percent": 59.57,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W24",
          "oee_percent": 58.14,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W25",
          "oee_percent": 54.98,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W26",
          "oee_percent": 56.81,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W27",
          "oee_percent": 54.36,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W28",
          "oee_percent": 56.95,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W29",
          "oee_percent": 57.56,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W30",
          "oee_percent": 59.77,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W31",
          "oee_percent": 58.37,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W32",
          "oee_percent": 57.05,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W33",
          "oee_percent": 57.65,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W34",
          "oee_percent": 60.51,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W35",
          "oee_percent": 55.99,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-W36",
          "oee_percent": 54.94,
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
      "subtitle": "2026-01-01 至 2026-09-14 · MT/ST 日 OEE 等权平均",
      "size": "wide",
      "data": [
        {
          "period_label": "2026-01",
          "oee_percent": 52.39,
          "max_point": null,
          "min_point": 52.39
        },
        {
          "period_label": "2026-02",
          "oee_percent": 53.68,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-03",
          "oee_percent": 55.15,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-04",
          "oee_percent": 58.1,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-05",
          "oee_percent": 56.85,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-06",
          "oee_percent": 58.12,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-07",
          "oee_percent": 56.87,
          "max_point": null,
          "min_point": null
        },
        {
          "period_label": "2026-08",
          "oee_percent": 58.26,
          "max_point": 58.26,
          "min_point": null
        },
        {
          "period_label": "2026-09",
          "oee_percent": 55.08,
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
      "metricDefinition": "按月聚合可计算的 MT/ST 日 OEE 并等权平均；极值按未舍入值比较，并列取最早期间",
      "warnings": [
        "可计算日类型 490/514；缺 Availability 24 个、缺 DUT 24 个；缺失或零分母结果为 NULL，平均仅使用可计算值",
        "部分月：2026-09；与完整周期比较时需注意覆盖天数"
      ]
    },
    {
      "id": "oee-trend-quarterly-2026",
      "kind": "line",
      "title": "OEE 季趋势（2026 年至今）",
      "subtitle": "2026-01-01 至 2026-09-14 · MT/ST 日 OEE 等权平均",
      "size": "wide",
      "data": [
        {
          "period_label": "2026-Q1",
          "oee_percent": 53.74,
          "max_point": null,
          "min_point": 53.74
        },
        {
          "period_label": "2026-Q2",
          "oee_percent": 57.67,
          "max_point": 57.67,
          "min_point": null
        },
        {
          "period_label": "2026-Q3",
          "oee_percent": 57.07,
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
      "metricDefinition": "按季聚合可计算的 MT/ST 日 OEE 并等权平均；极值按未舍入值比较，并列取最早期间",
      "warnings": [
        "可计算日类型 490/514；缺 Availability 24 个、缺 DUT 24 个；缺失或零分母结果为 NULL，平均仅使用可计算值",
        "部分季：2026-Q3；与完整周期比较时需注意覆盖天数"
      ]
    },
    {
      "id": "oee-extremes-table-2026",
      "kind": "table",
      "title": "OEE 极值明细（周/月/季）",
      "subtitle": "2026-01-01 至 2026-09-14 · 并列极值取最早期间；NULL 不参与排名",
      "size": "medium",
      "data": [
        {
          "grain": "周",
          "period_label": "2026-W21",
          "point_type": "最高",
          "oee_percent": 62.95,
          "availability_percent": 77.9,
          "performance_percent": 82.25,
          "dut_on_percent": 82.25,
          "test_time_percent": 98.85,
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
          "dut_on_percent": 79.65,
          "test_time_percent": 100,
          "yield_percent": 98.27,
          "calculable_day_type_count": 6
        },
        {
          "grain": "月",
          "period_label": "2026-08",
          "point_type": "最高",
          "oee_percent": 58.26,
          "availability_percent": 73.1,
          "performance_percent": 81.89,
          "dut_on_percent": 81.89,
          "test_time_percent": 98.8,
          "yield_percent": 98.43,
          "calculable_day_type_count": 54
        },
        {
          "grain": "月",
          "period_label": "2026-01",
          "point_type": "最低",
          "oee_percent": 52.39,
          "availability_percent": 67.76,
          "performance_percent": 78.7,
          "dut_on_percent": 78.7,
          "test_time_percent": 99.78,
          "yield_percent": 98.33,
          "calculable_day_type_count": 62
        },
        {
          "grain": "季",
          "period_label": "2026-Q2",
          "point_type": "最高",
          "oee_percent": 57.67,
          "availability_percent": 72.37,
          "performance_percent": 81.47,
          "dut_on_percent": 81.47,
          "test_time_percent": 98.79,
          "yield_percent": 98.89,
          "calculable_day_type_count": 172
        },
        {
          "grain": "季",
          "period_label": "2026-Q1",
          "point_type": "最低",
          "oee_percent": 53.74,
          "availability_percent": 68.83,
          "performance_percent": 79.52,
          "dut_on_percent": 79.52,
          "test_time_percent": 99.48,
          "yield_percent": 98.61,
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
            "key": "dut_on_percent",
            "label": "Performance (DUT-On) %"
          },
          {
            "key": "test_time_percent",
            "label": "Performance (Test Time) %"
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
      "metricDefinition": "周/月/季的 MT/ST 日 OEE 等权平均极值；四个组成项与 OEE 均使用同一期间 OEE 可计算日类型的等权平均值",
      "warnings": [
        "可计算日类型 490/514；缺 Availability 24 个、缺 DUT 24 个；缺失或零分母结果为 NULL，平均仅使用可计算值"
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
          "top10_machines": "1.ADH172(ST 0.34%)、2.ADH069(MT 1.57%)、3.ADH171(ST 4.67%)、4.ADH173(ST 4.98%)、5.ADH043(MT 5.37%)、6.ADH066(MT 5.58%)、7.ADH031(MT 6.03%)、8.ADH074(MT 6.44%)、9.ADH124(MT 7.11%)、10.ADH179(ST 8.71%)"
        },
        {
          "grain": "周",
          "point_type": "最高",
          "period_label": "2026-W21",
          "oee_percent": 62.95,
          "top10_machines": "1.ADH203(MT 0.26%)、2.ADH194(ST 2.09%)、3.ADH188(ST 3.69%)、4.ADH200(ST 4.34%)、5.ADH196(ST 4.64%)、6.ADH172(ST 5.12%)、7.ADH189(ST 5.14%)、8.ADH191(ST 5.27%)、9.ADH192(ST 5.47%)、10.ADH174(ST 5.59%)"
        },
        {
          "grain": "月",
          "point_type": "最低",
          "period_label": "2026-01",
          "oee_percent": 52.39,
          "top10_machines": "1.ADH153(ST 1.27%)、2.ADH170(ST 4.32%)、3.ADH005(MT 4.93%)、4.ADH149(ST 5.14%)、5.ADH037(MT 7.08%)、6.ADH162(ST 7.39%)、7.ADH169(ST 8.59%)、8.ADH026(MT 8.73%)、9.ADH198(ST 8.97%)、10.ADH143(MT 9.21%)"
        },
        {
          "grain": "月",
          "point_type": "最高",
          "period_label": "2026-08",
          "oee_percent": 58.26,
          "top10_machines": "1.ADH179(ST 3.07%)、2.ADH153(ST 4.27%)、3.ADH194(ST 4.91%)、4.ADH200(ST 5.05%)、5.ADH199(ST 5.19%)、6.ADH173(ST 5.25%)、7.ADH175(ST 5.41%)、8.ADH192(ST 5.75%)、9.ADH174(ST 5.82%)、10.ADH198(ST 6.26%)"
        },
        {
          "grain": "季",
          "point_type": "最低",
          "period_label": "2026-Q1",
          "oee_percent": 53.74,
          "top10_machines": "1.ADH037(MT 7.08%)、2.ADH005(MT 7.35%)、3.ADH201(MT 9.48%)、4.ADH026(MT 9.83%)、5.ADH046(MT 11.08%)、6.ADH199(ST 11.48%)、7.ADH175(ST 11.89%)、8.ADH194(ST 12.37%)、9.ADH066(MT 12.55%)、10.ADH171(ST 13.43%)"
        },
        {
          "grain": "季",
          "point_type": "最高",
          "period_label": "2026-Q2",
          "oee_percent": 57.67,
          "top10_machines": "1.ADH179(ST 5.28%)、2.ADH175(ST 5.92%)、3.ADH194(ST 7.02%)、4.ADH155(ST 7.24%)、5.ADH199(ST 7.72%)、6.ADH172(ST 7.76%)、7.ADH196(ST 7.94%)、8.ADH195(ST 8.12%)、9.ADH197(ST 8.36%)、10.ADH174(ST 9.46%)"
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
      "metricDefinition": "与 OEE 极值明细（周/月/季）逐项对应；周期 OEE 沿用日类型等权平均。机台 OEE 按同一周期整期汇总：运行秒数÷（有效 Availability 业务日数×86400）×SUM(IN_QTY)÷SUM(DUT_NUM)×[SUM(同日同类型截尾标准秒数×机台TD次数)÷SUM(机台实际测试秒数)]×SUM(OUT_QTY)÷SUM(IN_QTY)×100；标准秒数来自当日该类型全部合格 DUT，含无匹配 Availability 的记录；MT/ST 合并为一台，按 Availability 累计时长标注主要类型，并列取 MT。按未舍入机台 OEE 升序取最低 10 台，并列按机台编号；不足 10 台展示实际数量。年初首周及截至业务日的未完整月、季按实际范围统计，缺日不会补零。",
      "warnings": [
        "可计算日类型 490/514；缺 Availability 24 个、缺 DUT 24 个；缺失或零分母结果为 NULL，平均仅使用可计算值",
        "周 2026-W00（2026-01-01 至 2026-01-03）：可计算机台 93/101，展示 10 台；入榜机台 Availability 覆盖 1–3/3 天，DUT 覆盖 1–2/3 天；缺失或零分母为 NULL，不参与排名",
        "周 2026-W21（2026-05-24 至 2026-05-30）：可计算机台 149/149，展示 10 台；入榜机台 Availability 覆盖 1–7/7 天，DUT 覆盖 1–7/7 天；缺失或零分母为 NULL，不参与排名",
        "月 2026-01（2026-01-01 至 2026-01-31）：可计算机台 146/148，展示 10 台；入榜机台 Availability 覆盖 1–26/31 天，DUT 覆盖 1–24/31 天；缺失或零分母为 NULL，不参与排名",
        "月 2026-08（2026-08-01 至 2026-08-31）：可计算机台 150/150，展示 10 台；入榜机台 Availability 覆盖 3–27/31 天，DUT 覆盖 2–29/31 天；缺失或零分母为 NULL，不参与排名",
        "季 2026-Q1（2026-01-01 至 2026-03-31）：可计算机台 149/149，展示 10 台；入榜机台 Availability 覆盖 26–89/90 天，DUT 覆盖 20–81/90 天；缺失或零分母为 NULL，不参与排名",
        "季 2026-Q2（2026-04-01 至 2026-06-30）：可计算机台 151/151，展示 10 台；入榜机台 Availability 覆盖 76–84/91 天，DUT 覆盖 72–85/91 天；缺失或零分母为 NULL，不参与排名"
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
      "subtitle": "月累计 · 2026-09-01 至 2026-09-14 · 临时 Agent 分析",
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
      "metricDefinition": "2026-09-01 至 2026-09-14 的问题、优先级、措施与责任职能由临时 Agent 根据查询证据生成；损失小时仅引用本期实测记录，无法直接量化时为 NULL",
      "warnings": [
        "可计算日类型 26/28；缺 Availability 2 个、缺 DUT 2 个；缺失或零分母结果为 NULL，平均仅使用可计算值",
        "本次分析暂不可用：尚未生成临时 Agent 报告",
        "责任人列为职能建议，需管理层确认后指派到人",
        "本期为截至 2026-09-14 的部分月，损失小时不可与完整周期直接对比"
      ]
    },
    {
      "id": "improvement-actions-quarter-2026",
      "kind": "table",
      "title": "改善措施与责任人 · 季（2026-Q3）",
      "subtitle": "季累计 · 2026-07-01 至 2026-09-14 · 临时 Agent 分析",
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
      "metricDefinition": "2026-07-01 至 2026-09-14 的问题、优先级、措施与责任职能由临时 Agent 根据查询证据生成；损失小时仅引用本期实测记录，无法直接量化时为 NULL",
      "warnings": [
        "可计算日类型 138/152；缺 Availability 14 个、缺 DUT 14 个；缺失或零分母结果为 NULL，平均仅使用可计算值",
        "本次分析暂不可用：尚未生成临时 Agent 报告",
        "责任人列为职能建议，需管理层确认后指派到人",
        "本期为截至 2026-09-14 的部分季，损失小时不可与完整周期直接对比"
      ]
    }
  ]
};

export function createDefaultDashboard(): DashboardState {
  // Parsing validates the bundled snapshot and gives each session its own copy.
  return parseDashboardState(DEFAULT_DASHBOARD);
}
