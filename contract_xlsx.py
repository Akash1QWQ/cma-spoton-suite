# 把 合约记录.csv 转成带样式的 合约记录.xlsx（每次建立报价后自动重建）
import csv
import os
import sys
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'output')
CSV = os.path.join(OUT, '合约记录.csv')
XLSX = os.path.join(OUT, '合约记录.xlsx')

HEAD = ['时间', '目的港', '柜型×柜量', '船名/航次', '开船', '报价号', '状态', '20GP', '40HQ']
WIDTH = [19, 14, 22, 30, 12, 18, 10, 11, 11]

NAVY = 'FF1F3A6E'
WHITE = 'FFFFFFFF'
GRAY = 'FFF5F7FA'
GREEN = 'FF67C23A'
RED = 'FFF56C6C'
BLUE = 'FF3D5AFE'

thin = Side(style='thin', color='FFE4E7ED')
border = Border(left=thin, right=thin, top=thin, bottom=thin)


def read_rows():
    """只保留 24 小时内的记录（SpotOn 报价单 24 小时过期）"""
    if not os.path.exists(CSV):
        return []
    with open(CSV, encoding='utf-8-sig', newline='') as f:
        rd = csv.reader(f)
        rows = [r for r in rd if any(x.strip() for x in r)]
    if not rows:
        return []
    out = []
    now = datetime.now()
    for r in rows[1:]:
        try:
            t = datetime.strptime((r[0] or '').strip(), '%Y/%m/%d %H:%M:%S')
        except Exception:
            continue
        if (now - t).total_seconds() < 24 * 3600:
            out.append(r)
    return out


def main():
    rows = read_rows()
    wb = Workbook()
    ws = wb.active
    ws.title = '合约记录'

    # 标题行
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(HEAD))
    c = ws.cell(row=1, column=1, value='已建立的合约（SpotOn 报价单）')
    c.font = Font(size=13, bold=True, color=NAVY)
    c.alignment = Alignment(horizontal='left', vertical='center')
    ws.row_dimensions[1].height = 26

    # 副标题
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=len(HEAD))
    stamp = datetime.now().strftime('%Y-%m-%d %H:%M')
    c = ws.cell(row=2, column=1, value=f'共 {len(rows)} 条 · 更新于 {stamp}')
    c.font = Font(size=9, color='FF909399')
    c.alignment = Alignment(horizontal='left', vertical='center')

    # 表头
    hr = 3
    for i, h in enumerate(HEAD, 1):
        c = ws.cell(row=hr, column=i, value=h)
        c.font = Font(bold=True, color=WHITE, size=10)
        c.fill = PatternFill('solid', fgColor=NAVY)
        c.alignment = Alignment(horizontal='center', vertical='center')
        c.border = border
        ws.column_dimensions[get_column_letter(i)].width = WIDTH[i - 1]
    ws.row_dimensions[hr].height = 22

    # 数据：最新的在最上面
    r = hr + 1
    for row in reversed(rows):
        row = (row + [''] * len(HEAD))[: len(HEAD)]
        for i, v in enumerate(row, 1):
            c = ws.cell(row=r, column=i, value=v or '—')
            c.border = border
            ok = row[6] == '成功'
            if i == 7:
                c.font = Font(size=10, color=GREEN if ok else RED, bold=True)
            elif i == 6:
                c.font = Font(size=10, color=BLUE if ok else 'FF303133', bold=ok)
            else:
                c.font = Font(size=10, color='FF303133')
            c.alignment = Alignment(
                horizontal='left' if i in (1, 4) else 'center', vertical='center'
            )
            if r % 2 == 0:
                c.fill = PatternFill('solid', fgColor=GRAY)
        ws.row_dimensions[r].height = 19
        r += 1

    if not rows:
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=len(HEAD))
        c = ws.cell(row=r, column=1, value='还没有记录，先在「合约建立」里生成一个报价单')
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
    print(f'合约记录.xlsx 已更新（{len(rows)} 条）')


if __name__ == '__main__':
    sys.exit(main())
