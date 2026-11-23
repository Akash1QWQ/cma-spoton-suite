# -*- coding: utf-8 -*-
"""把已经查到的 output/raw/*.json + 上一轮结果里的费用，转成 fetch.js 的本地缓存，
   这样再跑就不会重复联网查询。"""
import glob, json, os, sys
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "output")
RAW = os.path.join(OUT, "raw")
CACHE = os.path.join(OUT, "cache")
os.makedirs(CACHE, exist_ok=True)

# 上一轮完整结果（拿来取费用明细）
if len(sys.argv) > 1:
    prev = json.load(open(sys.argv[1], encoding="utf-8"))
    print("参考结果:", os.path.basename(sys.argv[1]))
else:
    src = sorted(glob.glob(os.path.join(OUT, "CMA价格_*.json")), key=os.path.getmtime)
    src = [s for s in src if "明细" not in s]
    if not src:
        print("没有 CMA价格_*.json")
        sys.exit(1)
    prev = json.load(open(src[-1], encoding="utf-8"))
    print("参考结果:", os.path.basename(src[-1]))

POL = "CNXMN"
EQUIPS = ["20ST", "40HC"]
WEIGHT = 25000


def rate(line, t):
    for e in line.get("Equipments") or []:
        if e.get("EquipmentSizeType") == t and isinstance(e.get("OceanFreightRate"), (int, float)):
            return e["OceanFreightRate"]
    return None


def picks(offers):
    lines = [l for l in (offers.get("QuoteLineAndRoutingHeaders") or []) if l.get("Equipments")]
    if not lines:
        return None, None
    spot = [l for l in lines if l.get("HasSpot") is not False] or lines
    c20 = sorted([(rate(l, "20ST"), l["OfferId"]) for l in spot if rate(l, "20ST") is not None])
    c40 = sorted([(rate(l, "40HC"), l["OfferId"]) for l in spot if rate(l, "40HC") is not None])
    return (c20[0][1] if c20 else None), (c40[0][1] if c40 else None)


made = 0
for row in prev.get("results", []):
    code = (row.get("港口代码") or "").strip()
    if not code:
        continue
    raw_path = os.path.join(RAW, code + ".json")
    if not os.path.exists(raw_path):
        continue
    offers = json.load(open(raw_path, encoding="utf-8"))
    id20, id40 = picks(offers)
    fees = {}
    f20, f40 = row.get("起运港费20GP"), row.get("起运港费40HQ")
    if id20 and isinstance(f20, (int, float)):
        fees.setdefault(id20, {})["20ST"] = f20
    if id40 and isinstance(f40, (int, float)):
        fees.setdefault(id40, {})["40HC"] = f40
    json.dump({
        "meta": {"at": datetime.now(timezone.utc).astimezone().isoformat(), "pol": POL, "equips": EQUIPS, "weight": WEIGHT},
        "offers": offers,
        "fees": fees,
    }, open(os.path.join(CACHE, code + ".json"), "w", encoding="utf-8"), ensure_ascii=False)
    made += 1

print(f"写入缓存 {made} 个港口 -> {CACHE}")
