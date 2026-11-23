# -*- coding: utf-8 -*-
"""把 fetch.js 生成的 JSON 转成排版好的 Excel（汇总 + 航次明细）

用法：
  python to_xlsx.py               非洲、中南美各取最新一份，各出一个表
  python to_xlsx.py 某个.json      只转这一个
"""
import glob, json, os, sys
from datetime import datetime
import openpyxl
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))

HEAD_FILL = PatternFill("solid", fgColor="D9E1F2")
FAIL_FILL = PatternFill("solid", fgColor="FFC7CE")
WARN_FILL = PatternFill("solid", fgColor="FFF2CC")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

COLS = [
    ("分组", 16), ("目的港", 20),
    ("20GP", 9), ("40HQ", 9),
    ("重柜费20GP", 11),
    ("船名", 18), ("航次", 13), ("预计开船", 11), ("航程天数", 9), ("中转港", 26),
    ("备注", 32),
]
DCOLS = [("分组", 16), ("目的港", 18), ("港口代码", 9), ("船名", 18), ("航次", 13),
         ("预计开船", 11), ("预计到港", 11), ("航程天数", 9), ("中转港", 26),
         ("20GP", 10), ("40HQ", 10), ("重柜费20GP", 11),
         ("舱位", 8), ("船期", 8), ("有效期起", 11)]


def build(src):
    data = json.load(open(src, encoding="utf-8"))
    rows = data.get("results", [])
    # 汇总表要把「没查到可订数据」的港口也列出来（价格留空、备注写原因），
    # 否则港口会凭空消失、表看起来是错的
    all_rows = data.get("allResults") or rows
    details = data.get("details", [])
    stamp = datetime.now().strftime("%m%d_%H%M")
    base = os.path.basename(src)
    region = next((r + "_" for r in ("非洲", "中南美", "地中海黑海") if base.startswith("CMA价格_" + r)), "")
    out = os.path.join(HERE, "output", f"CMA报价_{region}{stamp}.xlsx")

    wb = openpyxl.Workbook()
    # 航次明细：港口顺序保持汇总表的顺序，每个港口内部按「预计开船」升序
    _order = {}
    for _i, _r in enumerate(all_rows):
        _order.setdefault(_r.get("目的港"), _i)
    def _key(d):
        etd = str(d.get("预计开船") or "")
        p20 = d.get("20GP")
        p20 = p20 if isinstance(p20, (int, float)) else 10 ** 9
        return (_order.get(d.get("目的港"), 10 ** 6), etd, p20)
    details = sorted(details, key=_key)

    ws = wb.active
    ws.title = "价格汇总"

    ws.append([c[0] for c in COLS])
    for i, (_, w) in enumerate(COLS, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
        cell = ws.cell(1, i)
        cell.font = Font(bold=True, size=10)
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"

    def _mark(r):
        """没查到的港口：把状态写进备注，让这一行看得懂"""
        if r.get("状态") == "正常":
            return r
        st = (r.get("状态") or "无报价").strip()
        rep = (r.get("备注") or "").strip()
        r2 = dict(r)
        r2["备注"] = st + ("：" + rep if rep else "")
        return r2

    for r in map(_mark, all_rows):
        ws.append([r.get(k, "") for k, _ in COLS])
        i = ws.max_row
        if r.get("状态") != "正常":
            for c in range(1, len(COLS) + 1):
                ws.cell(i, c).fill = FAIL_FILL
        if r.get("重柜费20GP"):
            ws.cell(i, 5).fill = WARN_FILL
        if r.get("备注"):
            ws.cell(i, len(COLS)).fill = WARN_FILL
        for c in (3, 4, 5):
            ws.cell(i, c).number_format = "#,##0"
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row, max_col=len(COLS)):
        for cell in row:
            cell.border = BORDER
            if cell.row > 1:
                cell.alignment = Alignment(vertical="center")
    ws.auto_filter.ref = f"A1:{get_column_letter(len(COLS))}{ws.max_row}"

    ws2 = wb.create_sheet("航次明细")
    ws2.append([c[0] for c in DCOLS])
    for i, (_, w) in enumerate(DCOLS, 1):
        ws2.column_dimensions[get_column_letter(i)].width = w
        cell = ws2.cell(1, i)
        cell.font = Font(bold=True, size=10)
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(horizontal="center", vertical="center")
    ws2.freeze_panes = "A2"
    for d in details:
        ws2.append([d.get(k, "") for k, _ in DCOLS])
    dnames = [k for k, _ in DCOLS]
    ov_col = dnames.index("重柜费20GP") + 1
    money_cols = [dnames.index(n) + 1 for n in ("20GP", "40HQ", "重柜费20GP") if n in dnames]
    for r in range(2, ws2.max_row + 1):
        if ws2.cell(r, ov_col).value:
            ws2.cell(r, ov_col).fill = WARN_FILL          # 重柜费标黄
        for c in money_cols:
            ws2.cell(r, c).number_format = "#,##0"
    for row in ws2.iter_rows(min_row=2, max_row=ws2.max_row, max_col=len(DCOLS)):
        for cell in row:
            cell.border = BORDER
    ws2.auto_filter.ref = f"A1:{get_column_letter(len(DCOLS))}{ws2.max_row}"

    # 跨月价格变动图表（第三个工作表）
    try:
        import month_chart
        month_chart.build(wb, rows, details, region)
    except Exception as e:
        print(f"   [警告] 跨月图表没生成：{e}")

    try:
        wb.save(out)
    except PermissionError:
        # 同名文件正被 Excel/WPS 打开，换个名字保存
        alt = out[:-5] + "_" + datetime.now().strftime("%S") + ".xlsx"
        wb.save(alt)
        print(f"   （原文件正被打开，另存为 {os.path.basename(alt)}）")
        out = alt

    # ---- 清理 openpyxl 写出来、WPS 不喜欢的几个空标签 ----
    # <workbookProtection /> 为空时，WPS 有时会把工作簿当“受保护”，连带的其它文档也变只读；
    # fullCalcOnLoad 会强制全表重算。这里直接改写 workbook.xml 去掉它们。
    try:
        import re as _re, shutil as _sh, zipfile as _zip, tempfile as _tf
        tmp_fd, tmp_path = _tf.mkstemp(suffix=".xlsx")
        os.close(tmp_fd)
        with _zip.ZipFile(out, "r") as zin, _zip.ZipFile(tmp_path, "w", _zip.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename == "xl/workbook.xml":
                    txt = data.decode("utf-8")
                    txt = _re.sub(r"<workbookProtection\s*/>", "", txt)
                    txt = txt.replace(' fullCalcOnLoad="1"', "")
                    data = txt.encode("utf-8")
                zout.writestr(item, data)
        _sh.move(tmp_path, out)
    except Exception as e:
        print(f"   [警告] 清理 workbook.xml 失败：{e}")

    # 只保留最近 3 份表格
    olds = [f for f in glob.glob(os.path.join(HERE, "output", f"CMA报价_{region}*.xlsx"))]
    olds.sort(key=os.path.getmtime, reverse=True)
    skipped = []
    for f in olds[3:]:
        try:
            os.remove(f)
        except Exception:
            skipped.append(os.path.basename(f))
    if skipped:
        print("   以下旧表格正在被 Excel 打开，关掉后下次运行会自动删除：" + "、".join(skipped))
    ok = sum(1 for r in rows if r.get("状态") == "正常")
    print(f"已生成 {os.path.basename(out)}：{len(rows)} 个港，航次明细 {len(details)} 行")



# ---------------- 变化记录（带颜色，看着不累） ----------------
CH_COLS = [
    ("目的港", 20), ("变化类型", 12),
    ("上次20GP", 11), ("本次20GP", 11), ("20GP涨跌", 11),
    ("上次40HQ", 11), ("本次40HQ", 11), ("40HQ涨跌", 11),
    ("上次开船", 12), ("本次开船", 12), ("上次船名", 26), ("本次船名", 26),
]

FILL_UP = PatternFill("solid", fgColor="FFE1E1")     # 涨价：淡红
FILL_DOWN = PatternFill("solid", fgColor="E4F6E4")   # 降价：淡绿
FILL_SHIFT = PatternFill("solid", fgColor="FFF4CC")  # 换船/改期：淡黄
FILL_NEW = PatternFill("solid", fgColor="E6F0FF")    # 新增：淡蓝
FILL_GONE = PatternFill("solid", fgColor="EFEFEF")   # 无报价：淡灰


def build_changes(json_path):
    """把 变化记录_*.json 变成带颜色的 xlsx"""
    import json as _json
    data = _json.load(open(json_path, encoding="utf-8-sig"))
    items = data.get("items") or []
    wb = Workbook()
    ws = wb.active
    ws.title = "变化记录"

    ws.append([c for c, _ in CH_COLS])
    for i, (_, w) in enumerate(CH_COLS, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for c in range(1, len(CH_COLS) + 1):
        cell = ws.cell(1, c)
        cell.font = Font(bold=True, color="FFFFFF", size=10)
        cell.fill = PatternFill("solid", fgColor="3D5AFE")
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BORDER
    ws.freeze_panes = "A2"

    def mark(row_cells, fill):
        for cell in row_cells:
            cell.fill = fill

    if not items:
        r = ws.max_row + 1
        ws.cell(r, 1, "(本次没有变化)")
        ws.cell(r, 2, "无变化")

    for it in items:
        r = ws.max_row + 1
        t = it.get("type", "")
        ws.cell(r, 1, it.get("name", ""))
        ws.cell(r, 2, t)
        if "o20" in it:
            ws.cell(r, 3, it.get("o20"))
            ws.cell(r, 4, it.get("n20"))
            ws.cell(r, 5, it.get("d20s") or "")
            ws.cell(r, 6, it.get("o40"))
            ws.cell(r, 7, it.get("n40"))
            ws.cell(r, 8, it.get("d40s") or "")
            for c in (3, 4, 6, 7):
                ws.cell(r, c).number_format = "#,##0"
        if it.get("oDate"):
            ws.cell(r, 9, it.get("oDate"))
            ws.cell(r, 10, it.get("nDate"))
            ws.cell(r, 11, it.get("oShip"))
            ws.cell(r, 12, it.get("nShip"))

        cells = [ws.cell(r, c) for c in range(1, len(CH_COLS) + 1)]
        for c in cells:
            c.border = BORDER
            c.font = Font(size=10)
        if t == "涨价":
            mark(cells, FILL_UP)
        elif t == "降价":
            mark(cells, FILL_DOWN)
        elif t == "有涨有降":
            mark(cells, PatternFill("solid", fgColor="FFF6E5"))
        if "o20" in it:
            # 20GP / 40HQ 的涨跌各自上色：涨=红底红字，降=绿底绿字
            for col, dv in ((5, it.get("d20") or 0), (8, it.get("d40") or 0)):
                cell = ws.cell(r, col)
                if dv > 0:
                    cell.fill = FILL_UP
                    cell.font = Font(size=10, bold=True, color="C00000")
                elif dv < 0:
                    cell.fill = FILL_DOWN
                    cell.font = Font(size=10, bold=True, color="1E7B34")
        elif t in ("换船", "改期"):
            mark(cells, FILL_SHIFT)
        elif t == "新增":
            mark(cells, FILL_NEW)
        elif t == "本次无报价":
            mark(cells, FILL_GONE)

    ws.auto_filter.ref = f"A1:{get_column_letter(len(CH_COLS))}{ws.max_row}"

    out = json_path[:-5] + ".xlsx"
    wb.save(out)
    print(f"   变化记录: {os.path.basename(out)}（{len(items)} 条）")
    return out


def main():
    if len(sys.argv) > 1:
        sources = [sys.argv[1]]
    else:
        sources = []
        for r in ("非洲", "中南美", "地中海黑海"):
            cands = [f for f in glob.glob(os.path.join(HERE, "output", f"CMA价格_{r}_*.json")) if "明细" not in f]
            # 只取「有数据」的最新一份，避免某次失败的空结果把表冲成 0 个港
            good = []
            for f in cands:
                try:
                    with open(f, encoding="utf-8") as fh:
                        if json.load(fh).get("results"):
                            good.append(f)
                except Exception:
                    pass
            if good:
                sources.append(max(good, key=os.path.getmtime))
        if not sources:
            print('output 目录里没有 CMA价格_*.json，先双击「更新价格.bat」查一次')
            sys.exit(1)
    for s in sources:
        build(s)

    # 顺带把每个区域最新一份「变化记录」转成带颜色的 xlsx
    for reg in ("非洲", "中南美", "地中海黑海"):
        cands = [f for f in glob.glob(os.path.join(HERE, "output", f"变化记录_{reg}_*.json"))]
        if not cands:
            continue
        newest = max(cands, key=os.path.getmtime)
        try:
            build_changes(newest)
        except Exception as e:
            print(f"   变化记录生成失败：{e}")


if __name__ == "__main__":
    main()
