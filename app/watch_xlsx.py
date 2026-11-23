# 把 抢舱记录.csv 转成带样式的 抢舱记录.xlsx（每次抢舱成功/失败后自动重建）
import csv
import os
import sys
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'output')
CSV = os.path.join(OUT, '抢舱记录.csv')
XLSX = os.path.join(OUT, '抢舱记录.xlsx')

HEAD = ['时间', '港口', '船名/航次', '开船', '20GP', '40HQ', '报价号', '结果']
WIDTH = [19, 16, 32, 12, 10, 10, 18, 26]

NAVY = 'FF1F3A6E'
WHITE = 'FFFFFFFF'
GRAY = 'FFF5F7FA'
GREEN = 'FF67C23A'
RED = 'FFF56C6C'
BLUE = 'FF3D5AFE'

thin = Side(style='thin', color='FFE4E7ED')
border = Border(left=thin, right=thin, top=thin, bottom=thin)


def read_rows():
    if not os.path.exists(CSV):
        return []
    with open(CSV, encoding='utf-8-sig', newline='') as f:
        rows = [r for r in csv.reader(f) if any((x or '').strip() for x in r)]
    return rows[1:] if rows else []


def main():
    rows = read_rows()
    wb = Workbook()
    ws = wb.active
    ws.title = '抢舱记录'

    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(HEAD))
    c = ws.cell(row=1, column=1, value='自动抢舱记录')
    c.font = Font(size=13, bold=True, color=NAVY)
    c.alignment = Alignment(horizontal='left', vertical='center')
    ws.row_dimensions[1].height = 26

    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=len(HEAD))
    c = ws.cell(row=2, column=1, value=f'共 {len(rows)} 条 · 更新于 {datetime.now().strftime("%Y-%m-%d %H:%M")}')
    c.font = Font(size=9, color='FF909399')
    c.alignment = Alignment(horizontal='left', vertical='center')

    hr = 3
    for i, h in enumerate(HEAD, 1):
        c = ws.cell(row=hr, column=i, value=h)
        c.font = Font(bold=True, color=WHITE, size=10)
        c.fill = PatternFill('solid', fgColor=NAVY)
        c.alignment = Alignment(horizontal='center', vertical='center')
        c.border = border
        ws.column_dimensions[get_column_letter(i)].width = WIDTH[i - 1]
    ws.row_dimensions[hr].height = 22

    r = hr + 1
    for row in reversed(rows):
        row = (row + [''] * len(HEAD))[: len(HEAD)]
        ok = row[7].startswith('成功')
        for i, v in enumerate(row, 1):
            c = ws.cell(row=r, column=i, value=v or '—')
            c.border = border
            if i == 8:
                c.font = Font(size=10, color=GREEN if ok else RED, bold=True)
            elif i == 7:
                c.font = Font(size=10, color=BLUE if ok else 'FF303133', bold=ok)
            else:
                c.font = Font(size=10, color='FF303133')
            c.alignment = Alignment(horizontal='left' if i in (1, 3, 8) else 'center', vertical='center')
            if r % 2 == 0:
                c.fill = PatternFill('solid', fgColor=GRAY)
        ws.row_dimensions[r].height = 19
        r += 1

    if not rows:
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=len(HEAD))
        c = ws.cell(row=r, column=1, value='还没有记录，先在「自动抢舱」里开始监控')
        c.font = Font(size=10, color='FF909399')
        c.alignment = Alignment(horizontal='center', vertical='center')
        ws.row_dimensions[r].height = 24

    ws.freeze_panes = f'A{hr + 1}'
    ws.auto_filter.ref = f'A{hr}:{get_column_letter(len(HEAD))}{max(hr, r - 1)}'
    ws.sheet_view.showGridLines = False

    try:
        wb.save(XLSX)
    except PermissionError:
        alt = XLSX.replace('.xlsx', f'_{datetime.now().strftime("%H%M%S")}.xlsx')
        wb.save(alt)
        print('XLSX 被占用，另存为: ' + os.path.basename(alt))
        return
    print(f'抢舱记录.xlsx 已更新（{len(rows)} 条）')


if __name__ == '__main__':
    sys.exit(main())
