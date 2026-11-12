"""Fixed value-only exporter; input comes from a complete, session-owned snapshot."""
import sys
sys.path.insert(0, "/xlsx-dependencies")

import math
import unicodedata
from datetime import datetime, timedelta, timezone
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

data = input_data.database
options = input_data.user
if not isinstance(data, dict) or data.get("truncated") is not False:
    raise ValueError("只能导出完整且未截断的数据快照")
rows = data.get("rows")
fields = data.get("columns")
if (not isinstance(rows, list) or not isinstance(fields, list) or
        len(rows) != data.get("rowCount") or len(rows) != options["expected_rows"] or
        fields != options["expected_columns"] or len(rows) > 100000):
    raise ValueError("快照内容与元数据不一致或超过行数上限")
columns = options["columns"]
if not columns or len(columns) > 16384:
    raise ValueError("Excel 导出必须包含 1 至 16384 列")

font = Font(name="Arial", size=11)
header_font = Font(name="Arial", size=11, bold=True, color="FFFFFF")
header_fill = PatternFill("solid", fgColor="234E70")
stripe_fill = PatternFill("solid", fgColor="F0F5FA")
alignment = Alignment(vertical="top")

def write_value(cell, value, display="auto"):
    cell.font = font
    cell.alignment = alignment
    if value is None:
        return
    if isinstance(value, str):
        # openpyxl otherwise infers formulas and Excel error cells from strings.
        if len(value) > 32767 or ILLEGAL_CHARACTERS_RE.search(value):
            raise ValueError("文本包含 Excel 不支持的字符或超过单元格长度上限")
        if display in ("number", "ratio", "percent"):
            raise ValueError("数值/百分比格式只能用于数值列")
        cell.value = value
        cell.data_type = "s"
        cell.number_format = "@"
    elif isinstance(value, bool):
        cell.value = value
    elif isinstance(value, (int, float)) and math.isfinite(value):
        if display == "text":
            cell.value = str(value)
            cell.data_type = "s"
            cell.number_format = "@"
        else:
            cell.value = value
            cell.number_format = ("0.00%" if display == "ratio" else
                                  '0.00"%"' if display == "percent" else
                                  "#,##0" if value == int(value) else "#,##0.00")
    else:
        raise ValueError("快照包含 Excel 无法表示的数据类型")

def width(value):
    return min(48, max((sum(2 if unicodedata.east_asian_width(c) in "WF" else 1
                           for c in line) for line in str(value).splitlines()), default=0) + 2)

wb = Workbook()
ws = wb.active
ws.title = "数据"
widths = []
for index, column in enumerate(columns, 1):
    if column["key"] not in fields:
        raise ValueError("导出字段不在快照中")
    cell = ws.cell(1, index)
    write_value(cell, column["title"])
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = Alignment(vertical="center", wrap_text=True)
    widths.append(max(12, width(column["title"])))
for row_index, row in enumerate(rows, 2):
    if not isinstance(row, dict) or any(key not in row for key in fields):
        raise ValueError("快照行缺少字段")
    for index, column in enumerate(columns, 1):
        value = row[column["key"]]
        cell = ws.cell(row_index, index)
        write_value(cell, value, column["format"])
        if row_index % 2 == 0:
            cell.fill = stripe_fill
        if value is not None:
            widths[index - 1] = max(widths[index - 1], width(value))
for index, size in enumerate(widths, 1):
    ws.column_dimensions[get_column_letter(index)].width = size
ws.freeze_panes = "A2"
ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{len(rows) + 1}"
ws.row_dimensions[1].height = 30
ws.sheet_view.showGridLines = False

notes = wb.create_sheet("说明")
now = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
for index, (label, value) in enumerate([
    ("报告", options["title"]),
    ("业务范围", options.get("description") or "以查询筛选条件为准"),
    ("导出时间", now + "（北京时间）"),
    ("数据行数", len(rows)),
    ("说明", "无数据" if not rows else "导出查询结果值；修改单元格不会自动重算。"),
    ("数值与空值", "数值保留原值，格式仅影响显示；空白表示缺失值。"),
], 1):
    write_value(notes.cell(index, 1), label)
    notes.cell(index, 1).font = Font(name="Arial", size=11, bold=True)
    write_value(notes.cell(index, 2), value)
    notes.cell(index, 2).alignment = Alignment(vertical="top", wrap_text=True)
notes.column_dimensions["A"].width = 18
notes.column_dimensions["B"].width = 64
wb.save("/work/workbook.xlsx")
wb.close()

# Check the actual serialized workbook before allowing it to be published.
check = load_workbook("/work/workbook.xlsx", read_only=True, data_only=False)
if check.sheetnames != ["数据", "说明"] or check["数据"].max_row != len(rows) + 1:
    raise ValueError("工作簿完整性校验失败")
for sheet in check:
    for row in sheet:
        if any(cell.data_type == "f" for cell in row):
            raise ValueError("结果值导出不能包含公式")
check.close()
emit_result(summary="Excel 导出完成", metrics={"rowCount": len(rows)})
