# -*- coding: utf-8 -*-
"""把「非洲后段」结果 JSON 生成带样式的 Excel"""
import glob
import json
import os
import sys
from datetime import datetime

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'output')

NAVY = 'FF1F3A6E'
WHITE = 'FFFFFFFF'
GRAY = 'FFF5F7FA'
GREEN = 'FF67C23A'
RED = 'FFF56C6C'
WARN = 'FFFFF2CC'

thin = Side(style='thin', color='FFE4E7ED')
border = Border(left=thin, right=thin, top=thin, bottom=thin)

COLS = [
    ('POD', 16), ('FPOD', 14), ('Mode', 15),
    ('MaxGW20', 10), ('MaxGW40', 10),
    ('后段20ST', 12), ('后段40HC', 12),
    ('基准船名/航次', 30), ('备注', 26),
]


def latest_json():
    files = [f for f in glob.glob(os.path.join(OUT, '非洲后段_*.json'))]
    if not files:
        return None
    files.sort(key=os.path.getmtime, reverse=True)
    return files[0]


def is_num(v):
    return isinstance(v, (int, float))


def main(src=None):
    src = src or latest_json()
    if not src or not os.path.exists(src):
        print('没有可用的后段结果 JSON')
        return 1
    data = json.load(open(src, encoding='utf-8'))
    rows = data.get('rows', [])
    stamp = datetime.now().strftime('%m%d_%H%M')
    out = os.path.join(OUT, f'非洲后段_{stamp}.xlsx')

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '非洲后段'

    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(COLS))
    c = ws.cell(row=1, column=1, value='非洲后段费用（内陆点 − 基本港）')
    c.font = Font(size=13, bold=True, color=NAVY)
    ws.row_dimensions[1].height = 26

    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=len(COLS))
    base = os.path.basename(data.get('baseFile') or '')
    c = ws.cell(row=2, column=1, value=f'共 {len(rows)} 条 · 基准报价 {base} · 生成于 {datetime.now().strftime("%Y-%m-%d %H:%M")}')
    c.font = Font(size=9, color='FF909399')

    hr = 3
    for i, (h, w) in enumerate(COLS, 1):
        cell = ws.cell(row=hr, column=i, value=h)
        cell.font = Font(bold=True, color=WHITE, size=10)
        cell.fill = PatternFill('solid', fgColor=NAVY)
        cell.alignment = Alignment(horizontal='center', vertical='center')
        cell.border = border
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.row_dimensions[hr].height = 22

    r = hr + 1
    for row in rows:
        for i, (h, _) in enumerate(COLS, 1):
            v = row.get(h, '')
            cell = ws.cell(row=r, column=i, value=v if v not in ('', None) else '')
            cell.border = border
            if h in ('后段20ST', '后段40HC'):
                if is_num(v):
                    cell.number_format = '#,##0'
                    cell.font = Font(size=10, bold=True, color='FF303133')
                else:
                    cell.font = Font(size=10, color=RED)
                    cell.fill = PatternFill('solid', fgColor='FFFDE9E9')
            elif h == '备注':
                cell.font = Font(size=9.5, color='FFB26A00' if v else 'FF909399')
                if v:
                    cell.fill = PatternFill('solid', fgColor=WARN)
            else:
                cell.font = Font(size=10, color='FF303133')
            cell.alignment = Alignment(
                horizontal='center' if h in ('MaxGW20', 'MaxGW40', '后段20ST', '后段40HC') else 'left',
                vertical='center')
            if r % 2 == 0 and h not in ('后段20ST', '后段40HC', '备注'):
                cell.fill = PatternFill('solid', fgColor=GRAY)
        ws.row_dimensions[r].height = 19
        r += 1

    ws.freeze_panes = f'A{hr + 1}'
    ws.auto_filter.ref = f'A{hr}:{get_column_letter(len(COLS))}{max(hr, r - 1)}'
    ws.sheet_view.showGridLines = False

    try:
        wb.save(out)
        print('已生成 ' + os.path.basename(out))
    except PermissionError:
        alt = out.replace('.xlsx', f'_{datetime.now().strftime("%H%M%S")}.xlsx')
        wb.save(alt)
        print('文件被占用，另存为 ' + os.path.basename(alt))

    # 只留最近 5 份
    xs = sorted(glob.glob(os.path.join(OUT, '非洲后段_*.xlsx')), key=os.path.getmtime, reverse=True)
    for f in xs[5:]:
        try:
            os.remove(f)
        except Exception:
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
