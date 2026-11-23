# -*- coding: utf-8 -*-
"""从现有运价表里抽出目的港清单，生成 ports.csv（后续程序按这个文件逐个查价）

取材：
  1) 桌面 "cma 10.18号非洲更新.xlsx" —— 西非CMA + 东非CMA（东非/莫桑比克/马达加斯加/南非）
  2) 桌面 "cma中南美10月底.xlsx"     —— All Rates（中南美）
"""
import csv, re, sys, os
import openpyxl

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "ports.csv")

AFRICA = r"C:\Users\Administrator\Desktop\cma 10.18号非洲更新.xlsx"
LATAM = r"C:\Users\Administrator\Desktop\cma中南美10月底.xlsx"

rows = []


def clean(s):
    return re.sub(r"\s+", " ", str(s).replace("\xa0", " ")).strip()


def add(group, raw, query, code, country, region="非洲"):
    if query:
        rows.append({"区域": region, "分组": group, "原表写法": raw, "查询名": query, "港口代码": code or "", "国家": country or ""})


def latin_of(p):
    """从 'Kenya 14' / 'Seychelles 塞舌尔 10' 里取出 Kenya / Seychelles"""
    m = re.match(r"([A-Za-z][A-Za-z .'\-]*?)\s*(?:[^\x00-\x7F]|\d|$)", p)
    return m.group(1).strip() if m else ""


def split_port(raw):
    """'Beira / Mozambique   贝拉   14' -> ('Beira', 'Mozambique')"""
    head = re.split(r"\s{2,}", raw)[0].strip()
    head = re.sub(r"\s*\(.*?\)", "", head)          # 去掉括号（如 COEGA / 港口代码）
    parts = [p.strip() for p in re.split(r"[/,]", head) if p.strip()]
    name = latin_of(parts[0]) or re.split(r"[^\x00-\x7F]", parts[0])[0].strip()
    name = re.sub(r"\s+\d+$", "", name).strip()
    tokens = [t for t in (latin_of(p) for p in parts[1:]) if t]
    return name, "|".join(tokens)


# ---------------- 非洲表：西非 + 东非 ----------------
wb = openpyxl.load_workbook(AFRICA, data_only=True)
for sheet, default_group in (("西非CMA", "西非"), ("东非CMA ", "东非")):
    ws = wb[sheet]
    group = default_group
    for r in range(1, ws.max_row + 1):
        b = ws.cell(r, 2).value
        if not b:
            continue
        raw = clean(b)
        if raw in ("目的港", "起运港"):
            continue
        e = clean(ws.cell(r, 5).value) if ws.cell(r, 5).value is not None else ""
        if e == "20GP/40HQ":          # 分组标题行
            group = raw
            continue
        name, country = split_port(raw)
        add(group, raw, name, "", country)

# ---------------- 中南美表 ----------------
wb2 = openpyxl.load_workbook(LATAM, data_only=True)
ws2 = wb2["All Rates"]
group = "中南美"
for r in range(2, ws2.max_row + 1):
    v = ws2.cell(r, 2).value
    if not v:
        continue
    raw = clean(v)
    if raw.startswith("Validity"):
        continue
    codes = re.findall(r"\(([A-Z]{2}[A-Z0-9]{3})", raw) or re.findall(r"\b([A-Z]{2}[A-Z0-9]{3})\b", raw)
    code = codes[0] if codes else ""
    name = re.sub(r"\(.*?\)", "", raw)
    name = re.split(r"[,/]", name)[0].strip()
    name = re.split(r"[^\x00-\x7F]", name)[0].strip() or name
    add(group, raw, name, code, "", region="中南美")

# 去重（同组同名只留一条）
seen, uniq = set(), []
for r in rows:
    key = (r["分组"], r["查询名"].upper())
    if key in seen:
        continue
    seen.add(key)
    uniq.append(r)

with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["区域", "分组", "原表写法", "查询名", "港口代码", "国家"])
    w.writeheader()
    w.writerows(uniq)

from collections import Counter
print(f"写出 {OUT}，共 {len(uniq)} 个目的港")
for k, v in Counter(r["分组"] for r in uniq).items():
    print(f"  {k}: {v}")
