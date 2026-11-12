"""Fixed offline XLSX reader/editor. No user code, formulas or external fetches."""
import sys
sys.path.insert(0, "/xlsx-dependencies")
import json
import math
import re
import zipfile
from copy import copy
from datetime import date, datetime, time
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET
from openpyxl import load_workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE, MergedCell
from openpyxl.utils.cell import range_boundaries, get_column_letter

MAX_CELLS = 200000
MAX_EDIT_CELLS = 10000
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def fail(message):
    raise ValueError(message)


def validate_package(filename="/input/workbook.xlsx"):
    with zipfile.ZipFile(filename) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 2000 or len(names) != len(set(names)):
            fail("Excel 压缩包条目过多或重复")
        if sum(entry.file_size for entry in entries) > 64 * 1024 * 1024:
            fail("Excel 解压后超过 64 MiB 上限")
        if "[Content_Types].xml" not in names or "xl/workbook.xml" not in names:
            fail("仅支持普通 .xlsx 工作簿")
        cell_count = 0
        merged_cells = 0
        for entry in entries:
            name = entry.filename
            if entry.flag_bits & 1 or "\\" in name or name.startswith("/") or ".." in PurePosixPath(name).parts:
                fail("Excel 包含加密或无效条目")
            lower = name.lower()
            if (lower.endswith(".bin") or any(part in lower for part in (
                "vbaproject", "xl/externallinks/", "xl/embeddings/", "xl/activex/", "xl/drawings/",
                "xl/charts/", "xl/pivot", "xl/slicer", "xl/querytables/", "xl/connections", "xl/threadedcomments/",
                "xl/persons/", "xl/richdata/", "xl/chartsheets/", "customxml/", "_xmlsignatures/"))):
                fail("当前仅支持普通 xlsx：不支持宏、外部数据连接、图形、透视表或嵌入对象")
            if lower.endswith((".xml", ".rels")):
                data = archive.read(entry)
                normalized = data.replace(b"\x00", b"").upper()
                if b"<!DOCTYPE" in normalized or b"<!ENTITY" in normalized:
                    fail("Excel XML 包含不支持的实体声明")
                root = ET.fromstring(data)
                for element in root.iter():
                    tag = element.tag.rsplit("}", 1)[-1]
                    if tag in ("extLst", "AlternateContent"):
                        fail("工作簿含有当前编辑器无法完整保留的扩展功能")
                    if tag == "Override" and ("macroenabled" in element.attrib.get("ContentType", "").lower()
                        or "spreadsheetml.template" in element.attrib.get("ContentType", "").lower()):
                        fail("不支持宏工作簿或模板，请上传普通 .xlsx")
                    if tag == "Relationship" and element.attrib.get("TargetMode") == "External" and not element.attrib.get("Type", "").endswith("/hyperlink"):
                        fail("不支持外部工作簿或数据连接")
                    if element.tag == NS + "mergeCell":
                        left, top, right, bottom = range_boundaries(element.attrib.get("ref", ""))
                        if not all(isinstance(n, int) for n in (left, top, right, bottom)) or not (1 <= left <= right <= 16384 and 1 <= top <= bottom <= 1048576):
                            fail("合并区域无效")
                        merged_cells += (right - left + 1) * (bottom - top + 1)
                        if merged_cells > MAX_CELLS:
                            fail("合并区域超过 200000 个单元格上限")
                    if element.tag == NS + "c":
                        cell_count += 1
        if cell_count > MAX_CELLS:
            fail("工作簿超过 200000 个已存储单元格上限")


def bounds(value, limit):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?", value):
        fail("区域必须为明确的 A1 或 A1:C10，不接受整行、整列或公式")
    left, top, right, bottom = range_boundaries(value.upper())
    if not (1 <= left <= right <= 16384 and 1 <= top <= bottom <= 1048576):
        fail("单元格区域超出 Excel 范围")
    if (right - left + 1) * (bottom - top + 1) > limit:
        fail("指定区域超过单次单元格上限")
    return left, top, right, bottom


def sheet_named(name):
    if name not in workbook.sheetnames:
        fail("工作表不存在")
    return workbook[name]


def json_value(cell):
    value = cell.value
    if isinstance(value, (datetime, date, time)):
        value = value.isoformat()
    elif not isinstance(value, (str, int, float, bool, type(None))):
        value = str(value)
    if isinstance(value, float) and not math.isfinite(value):
        value = str(value)
    return value


def valid_value(value):
    if isinstance(value, str):
        if len(value) > 32767 or ILLEGAL_CHARACTERS_RE.search(value):
            fail("文本过长或包含非法字符")
    elif value is not None and type(value) not in (int, float, bool):
        fail("单元格仅接受文本、数值、布尔值或空值")
    elif isinstance(value, (int, float)) and not math.isfinite(value):
        fail("数值必须有限")


FORMATS = {"text": "@", "integer": "#,##0", "decimal": "#,##0.00", "ratio": "0.00%", "percent": '0.00"%"', "general": "General"}


def valid_format(style):
    allowed = {"number_format", "bold", "italic", "font_size", "font_color", "fill_color", "alignment", "wrap_text", "column_width", "row_height"}
    if not isinstance(style, dict) or not style or set(style) - allowed:
        fail("格式配置无效")
    for key, value in style.items():
        if key in ("bold", "italic", "wrap_text") and type(value) is not bool:
            fail("格式开关必须是布尔值")
        if key in ("font_color", "fill_color") and (not isinstance(value, str) or not re.fullmatch(r"[0-9A-Fa-f]{6}", value)):
            fail("颜色必须为六位 RGB 十六进制")
        if key == "number_format" and value not in FORMATS:
            fail("数字格式无效")
        if key == "alignment" and value not in ("left", "center", "right"):
            fail("对齐方式无效")
        if key in ("font_size", "column_width", "row_height") and (type(value) not in (int, float) or not math.isfinite(value) or not 1 <= value <= (72 if key == "font_size" else 100 if key == "column_width" else 200)):
            fail("字号、列宽或行高超出允许范围")


def apply_style(cell, style):
    font = copy(cell.font)
    for key, attribute in (("bold", "bold"), ("italic", "italic"), ("font_size", "size"), ("font_color", "color")):
        if key in style:
            setattr(font, attribute, style[key])
    cell.font = font
    if "fill_color" in style:
        from openpyxl.styles import PatternFill
        cell.fill = PatternFill(fill_type="solid", fgColor=style["fill_color"])
    if "number_format" in style:
        cell.number_format = FORMATS[style["number_format"]]
    alignment = copy(cell.alignment)
    if "alignment" in style:
        alignment.horizontal = style["alignment"]
    if "wrap_text" in style:
        alignment.wrap_text = style["wrap_text"]
    cell.alignment = alignment


validate_package()
workbook = load_workbook("/input/workbook.xlsx", data_only=False, keep_links=False, rich_text=True)
if len(workbook.worksheets) > 100:
    fail("工作簿超过 100 个工作表上限")
options = input_data.user
action = options.get("action")
formula_count = sum(cell.data_type == "f" for sheet in workbook for cell in sheet._cells.values())
notes = ["公式表达式保留，但本地不计算公式。修改后公式缓存将失效，结果需在 Excel 中重新计算。"] if formula_count else []
sheets = [{"name": sheet.title, "rows": sheet.max_row, "columns": sheet.max_column,
           "merged_ranges": [str(item) for item in list(sheet.merged_cells.ranges)[:50]],
           "merged_range_count": len(sheet.merged_cells.ranges)} for sheet in workbook]
if action == "validate":
    emit_result(summary="工作簿验证成功")
elif action == "inspect":
    data = {"sheets": sheets, "formula_count": formula_count}
    if options.get("sheet") is not None or options.get("range") is not None:
        if not options.get("sheet") or not options.get("range"):
            fail("查看区域需要同时指定工作表和区域")
        sheet = sheet_named(options["sheet"])
        left, top, right, bottom = bounds(options["range"], 200)
        cells = []
        for row in sheet.iter_rows(min_row=top, max_row=bottom, min_col=left, max_col=right):
            for cell in row:
                value = json_value(cell)
                truncated = isinstance(value, str) and len(value) > 200
                cells.append({"cell": cell.coordinate, "value": value[:200] if truncated else value,
                              "type": cell.data_type, "number_format": cell.number_format[:120], "truncated": truncated})
        data.update({"sheet": sheet.title, "range": options["range"], "cells": cells})
    # Keep previews bounded independently of multibyte text and custom formats.
    if len(json.dumps(data, ensure_ascii=False).encode("utf-8")) > 48000:
        for cell in data.get("cells", []):
            if isinstance(cell["value"], str) and len(cell["value"]) > 40:
                cell["value"] = cell["value"][:40]
                cell["truncated"] = True
        for sheet in data["sheets"]:
            sheet["merged_ranges"] = sheet["merged_ranges"][:5]
    if len(json.dumps(data, ensure_ascii=False).encode("utf-8")) > 48000:
        fail("区域预览内容过大，请缩小查看区域")
    emit_result(summary="工作簿读取成功", data=data, notes=notes)
elif action == "edit":
    operations = options.get("operations")
    if not isinstance(operations, list) or not 1 <= len(operations) <= 100:
        fail("每次修改需要 1 至 100 个操作")
    affected = 0
    value_cells = set()
    format_cells = set()
    ranges = []
    replaced_formulas = set()
    for operation in operations:
        if not isinstance(operation, dict):
            fail("操作必须为对象")
        kind = operation.get("type")
        fields = {"set": {"type", "sheet", "range", "values"}, "fill": {"type", "sheet", "range", "value"}, "format": {"type", "sheet", "range", "style"}}
        if kind not in fields or set(operation) != fields[kind]:
            fail("修改操作字段无效")
        sheet = sheet_named(operation["sheet"])
        if sheet.protection.sheet:
            fail("不修改受保护的工作表")
        left, top, right, bottom = bounds(operation["range"], MAX_EDIT_CELLS)
        affected += (right - left + 1) * (bottom - top + 1)
        if affected > MAX_EDIT_CELLS:
            fail("每次修改累计最多 10000 个单元格")
        if kind == "set":
            values = operation.get("values")
            if not isinstance(values, list) or len(values) != bottom - top + 1 or any(not isinstance(row, list) or len(row) != right - left + 1 for row in values):
                fail("数据行列数必须与指定区域完全一致")
            for row in values:
                for value in row:
                    valid_value(value)
        elif kind == "fill":
            valid_value(operation.get("value"))
        else:
            valid_format(operation.get("style"))
        for row in sheet.iter_rows(min_row=top, max_row=bottom, min_col=left, max_col=right):
            for cell in row:
                if isinstance(cell, MergedCell):
                    if kind != "format":
                        fail("合并单元格只能修改左上角单元格")
                    continue
                key = (sheet.title, cell.coordinate)
                if kind == "format":
                    apply_style(cell, operation["style"])
                    format_cells.add(key)
                else:
                    if cell.data_type == "f":
                        replaced_formulas.add(key)
                    value = operation["value"] if kind == "fill" else operation["values"][cell.row - top][cell.column - left]
                    cell.value = value
                    if isinstance(value, str):
                        cell.data_type = "s"
                    value_cells.add(key)
        if kind == "format":
            style = operation["style"]
            if "column_width" in style:
                for column in range(left, right + 1):
                    sheet.column_dimensions[get_column_letter(column)].width = style["column_width"]
            if "row_height" in style:
                for row in range(top, bottom + 1):
                    sheet.row_dimensions[row].height = style["row_height"]
        ranges.append({"sheet": sheet.title, "range": operation["range"].upper(), "type": kind})
    if workbook.calculation is not None:
        workbook.calculation.fullCalcOnLoad = True
        workbook.calculation.forceFullCalc = True
    workbook.save("/work/workbook.xlsx")
    validate_package("/work/workbook.xlsx")
    check = load_workbook("/work/workbook.xlsx", data_only=False, rich_text=True)
    if check.sheetnames != workbook.sheetnames:
        fail("修改后工作表校验失败")
    for sheet_name, address in value_cells | format_cells:
        expected, actual = workbook[sheet_name][address], check[sheet_name][address]
        if expected.value != actual.value or expected.data_type != actual.data_type:
            # openpyxl normalizes empty strings to blank cells on reading.
            if not (expected.value == "" and actual.value is None):
                fail("修改后单元格校验失败")
    summary = f"已写入 {len(value_cells)} 个单元格，设置 {len(format_cells)} 个单元格格式，共 {len(operations)} 个操作。"
    if replaced_formulas:
        summary += f"其中 {len(replaced_formulas)} 个原有公式被替换为结果值。"
    emit_result(summary=summary, data={"changes": ranges, "notes": notes},
                metrics={"value_cells": len(value_cells), "format_cells": len(format_cells), "replaced_formulas": len(replaced_formulas)})
else:
    fail("不支持的 Excel 操作")
