# -*- coding: utf-8 -*-
"""价格变动图表：按分组对比「本期」和「下期」两个半月窗口的价格。

窗口规则（跟着今天滑动，半月为 1–14 号 / 15 号–月末）：
  - 今天是 10-21 → 本期 10/15–10-31，下期 11/01–11/14
  - 今天是 11-07 → 本期 11/01–11/14，下期 11/15–11/30
取数：按「预计开船」落在窗口内，只统计舱位 != 已满，取 20GP / 40HQ 各自最低。
图：每个分组两张（20GP 一张、40HQ 一张），每港两根柱（本期 / 下期）。
"""
import calendar
import csv
import math
import os
from datetime import date

from openpyxl.chart import BarChart, Reference, Series
from openpyxl.chart.legend import Legend
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
PORTS_FILE = os.path.join(HERE, "ports.csv")
SHEET_NAME = "价格变动图表"

TITLE_FILL = PatternFill("solid", fgColor="DDE4FB")
HEAD_FILL = PatternFill("solid", fgColor="3D5AFE")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
UP_COLOR = "C00000"
DOWN_COLOR = "1E7B34"

COLS = ["港口", "20GP 本期", "20GP 下期", "20GP 差", "40HQ 本期", "40HQ 下期", "40HQ 差"]
WIDTHS = [20, 14, 14, 11, 14, 14, 11]

# 中南美：加勒比拆成两块，其余按给的三张清单
CARIBS_ISLANDS = {
    "Panama", "Kingston", "Port of Spain", "Rio Haina", "Lafito", "Cap Haitien",
    "San Juan", "Mariel  DTHC:EUR250", "POINTE A PITRE", "FORT DE FRANCE",
    "PHILIPSBURG", "GUSTAVIA", "DEGRAD DES CANNES", "Nassau", "Georgetown",
    "Belize City",
}
CARIBS_MAINLAND = {
    "Cartagena", "Santa Marta", "Barranquilla", "Turbo", "Puerto Cabello",
    "Maracaibo", "El Guamache", "Manaus", "Puerto Cortes", "Puerto Moin",
    "Altamira", "Progreso",
}
SAM_WEST = {
    "Manzanillo", "Lazaro Cardenas", "Callao", "Buenaventura", "Chancay", "Posorja",
    "San Antonio", "Ensenada", "Lirquen", "Arica", "Iquique", "Puerto Quetzal",
    "Acajutla", "Corinto", "Puerto Caldera", "Managua",
}
SAM_EAST = {
    "Santos", "Rio de Janeiro", "Navegantes", "Paranagua", "Itapoa", "Itajai",
    "Buenos Aires", "Montevideo", "Rio Grande", "Rosario", "Zarate", "Mar Del Plata",
    "Suape", "Fortaleza", "Salvador", "Pecem", "Vitoria", "Vila do Conde", "Asuncion",
}

CARIBS_A = "加勒比 · 巴拿马/岛屿"
CARIBS_B = "加勒比 · 南美北岸/中美"
LATAM_W = "南美西+中美洲"
LATAM_E = "南美东"
LATAM_ORDER = [CARIBS_A, CARIBS_B, LATAM_W, LATAM_E]


def load_chart_groups():
    mapping, order = {}, []
    if not os.path.exists(PORTS_FILE):
        return mapping, order
    with open(PORTS_FILE, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            port = (r.get("查询名") or "").strip()
            region = (r.get("区域") or "").strip()
            if region == "中南美":
                if port in CARIBS_ISLANDS:
                    g = CARIBS_A
                elif port in CARIBS_MAINLAND:
                    g = CARIBS_B
                elif port in SAM_WEST:
                    g = LATAM_W
                elif port in SAM_EAST:
                    g = LATAM_E
                else:
                    g = "中南美其他"
            else:
                g = (r.get("分组") or "").strip() or "未分组"
            if port:
                mapping[port] = g
            if g not in order:
                order.append(g)
    return mapping, order


def _last_day(y, m):
    return calendar.monthrange(y, m)[1]


def windows(today=None):
    """返回 ((本期开始, 本期结束), (下期开始, 下期结束))"""
    today = today or date.today()
    y, m, d = today.year, today.month, today.day
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    if d <= 14:
        # 上半月：本期 = 本月 1–14，下期 = 本月 15–月末
        cur = (f"{y}-{m:02d}-01", f"{y}-{m:02d}-14")
        nxt = (f"{y}-{m:02d}-15", f"{y}-{m:02d}-{_last_day(y, m):02d}")
    else:
        # 下半月：本期 = 本月 15–月末，下期 = 次月 1–14
        cur = (f"{y}-{m:02d}-15", f"{y}-{m:02d}-{_last_day(y, m):02d}")
        nxt = (f"{ny}-{nm:02d}-01", f"{ny}-{nm:02d}-14")
    return cur, nxt


def _num(v):
    return v if isinstance(v, (int, float)) else None


def collect(details):
    cur, nxt = windows()

    def which(etd):
        if cur[0] <= etd <= cur[1]:
            return "c"
        if nxt[0] <= etd <= nxt[1]:
            return "n"
        return None

    out = {}
    for x in details:
        if x.get("舱位") == "已满":
            continue
        port = x.get("目的港")
        etd = str(x.get("预计开船") or "")[:10]
        if not port or len(etd) != 10:
            continue
        w = which(etd)
        if not w:
            continue
        slot = out.setdefault(port, {})
        for key, fld in ((f"k20{w}", "20GP"), (f"k40{w}", "40HQ")):
            v = _num(x.get(fld))
            if v is None:
                continue
            if key not in slot or v < slot[key]:
                slot[key] = v
    return out


def _add_chart(ws, first_row, last_row, anchor_row, title, series_defs, horizontal):
    chart = BarChart()
    chart.type = "bar" if horizontal else "col"
    chart.grouping = "clustered"
    chart.overlap = -10
    chart.gapWidth = 60
    chart.title = title
    chart.y_axis.title = "USD"
    chart.height = max(9, 4 + 0.6 * (last_row - first_row + 1)) if horizontal else 9
    chart.width = 20
    chart.legend = Legend()
    chart.legend.position = "b"

    for col, name, color in series_defs:
        ser = Series(Reference(ws, min_col=col, min_row=first_row, max_row=last_row), title=name)
        gp = GraphicalProperties(solidFill=color)
        gp.line = None
        ser.graphicalProperties = gp
        chart.series.append(ser)
    chart.set_categories(Reference(ws, min_col=1, min_row=first_row, max_row=last_row))

    ws.add_chart(chart, f"I{anchor_row}")
    return int(math.ceil(chart.height * 28.35 / 15.0)) + 2


def build(wb, rows, details, region):
    mapping, order = load_chart_groups()
    data = collect(details)
    cur, nxt = windows()

    ws = wb.create_sheet(SHEET_NAME)
    for i, w in enumerate(WIDTHS, 1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws["A1"] = f"价格变动图表 · {region.rstrip('_')}"
    ws["A1"].font = Font(bold=True, size=13)
    ws["A2"] = (f"本期 {cur[0]} ~ {cur[1]}　|　下期 {nxt[0]} ~ {nxt[1]}"
                f"　（按预计开船日归期，已满的航次不参与）")
    ws["A2"].font = Font(size=9, color="6E7684")
    ws.merge_cells("A1:G1")
    ws.merge_cells("A2:G2")

    grouped = {}
    for r in rows:
        port = r.get("目的港")
        if not port or port not in data:
            continue
        g = mapping.get(port) or (r.get("分组") or "未分组")
        grouped.setdefault(g, []).append(port)

    seq = LATAM_ORDER if region.startswith("中南美") else order
    groups = [x for x in seq if x in grouped] + [x for x in grouped if x not in seq]

    row = 4
    written = 0
    for g in groups:
        recs = []
        for p in grouped[g]:
            d = data[p]
            a20, b20 = d.get("k20c"), d.get("k20n")
            a40, b40 = d.get("k40c"), d.get("k40n")
            recs.append({
                "port": p, "a20": a20, "b20": b20, "a40": a40, "b40": b40,
                "d20": (b20 - a20) if (a20 is not None and b20 is not None) else None,
                "d40": (b40 - a40) if (a40 is not None and b40 is not None) else None,
            })
        if not recs:
            continue

        ws.cell(row, 1, g).font = Font(bold=True, size=11, color="1F2A44")
        for c in range(1, 8):
            ws.cell(row, c).fill = TITLE_FILL
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=7)
        row += 1

        for c, name in enumerate(COLS, 1):
            cell = ws.cell(row, c, name)
            cell.font = Font(bold=True, size=9, color="FFFFFF")
            cell.fill = HEAD_FILL
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            cell.border = BORDER
        head_row = row
        row += 1

        for rec in recs:
            ws.cell(row, 1, rec["port"]).font = Font(size=9)
            for c, key in ((2, "a20"), (3, "b20"), (5, "a40"), (6, "b40")):
                cell = ws.cell(row, c, rec[key] if rec[key] is not None else None)
                cell.number_format = "#,##0"
                cell.font = Font(size=9)
            for c, key in ((4, "d20"), (7, "d40")):
                v = rec[key]
                cell = ws.cell(row, c, ("+" + str(v)) if (v is not None and v > 0) else (v if v is not None else None))
                cell.font = Font(size=9, bold=bool(v),
                                 color=(UP_COLOR if (v or 0) > 0 else DOWN_COLOR if (v or 0) < 0 else "000000"))
            for c in range(1, 8):
                ws.cell(row, c).border = BORDER
            row += 1
        last_row = row - 1

        changed = [i for i, rec in enumerate(recs)
                   if (rec["d20"] not in (None, 0)) or (rec["d40"] not in (None, 0))]
        picked = (changed if changed else list(range(len(recs))))[:20]
        note = (f"（图上只显示有变动的 {len(picked)} 个港；本组共 {len(recs)} 个港）"
                if changed else
                f"（本组两个窗口同价，图上显示全部 {len(picked)} 个有数据的港）")
        ws.cell(row, 1, note).font = Font(size=9, color="6E7684")
        row += 1

        horizontal = len(picked) > 14
        used = _add_chart(
            ws, head_row + 1, last_row, head_row - 1, g,
            [(2, "20GP 本期", "3D5AFE"), (3, "20GP 下期", "9FB0FF"),
             (5, "40HQ 本期", "FF9F1C"), (6, "40HQ 下期", "FFD08A")],
            horizontal,
        )
        row = max(row, head_row + used)
        row += 1
        written += 1

    if written == 0:
        ws.cell(3, 1, "（本次数据里没有落在本期/下期的船期，图表为空）").font = Font(size=10, color="C00000")
    return ws
