"""Builds the before/after workbook pairs for the Excel connector's region diff (test/fixtures/excel-region/<id>-before.xlsx, -after.xlsx).

Written with openpyxl, the library agents use most, so the files carry openpyxl's real shapes (inline strings, no cached values unless
injected, charts dropped on a load and save). Where rows move, the after side is written the way Excel leaves it: rows below move and
every formula reference is rewritten. "with caches" fixtures get cached <v> values injected after the save.

Rerun from the repo root:  python3 test/fixtures/build-excel-region-fixtures.py
"""
import datetime
import io
import os
import re
import zipfile

import openpyxl
from openpyxl.chart import LineChart, Reference

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "excel-region")
FIXED = datetime.datetime(2026, 11, 10, 12, 0, 0)


def new_wb():
    wb = openpyxl.Workbook()
    wb.properties.created = FIXED
    wb.properties.modified = FIXED
    return wb


def save(wb, name, caches=None):
    path = os.path.join(OUT, name)
    wb.properties.created = FIXED
    wb.properties.modified = FIXED
    wb.save(path)
    if caches:
        inject_caches(path, caches)
    stabilize(path)


def stabilize(path):
    """Fixed zip timestamps and docProps dates, so reruns are byte-stable."""
    zin = zipfile.ZipFile(path)
    items = [(i.filename, zin.read(i.filename)) for i in zin.infolist()]
    zin.close()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n, b in items:
            if n == "docProps/core.xml":
                b = re.sub(rb"<dcterms:(created|modified)([^>]*)>[^<]*<", lambda m: b"<dcterms:" + m.group(1) + m.group(2) + b">2026-11-10T12:00:00Z<", b)
            zi = zipfile.ZipInfo(n, date_time=(2026, 11, 10, 12, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, b)
    open(path, "wb").write(buf.getvalue())


def inject_caches(path, caches):
    """caches: {sheet xml part name: {cell ref: value}}; puts <v> into formula cells (an error string like '#DIV/0!' gets t="e")."""
    zin = zipfile.ZipFile(path)
    items = [(i.filename, zin.read(i.filename)) for i in zin.infolist()]
    zin.close()
    out = []
    for n, b in items:
        if n in caches:
            vals = caches[n]
            s = b.decode("utf-8")

            def rep(m):
                ref = m.group(2)
                if ref not in vals:
                    return m.group(0)
                v = vals[ref]
                attrs = m.group(1)
                attrs = re.sub(r'\st="[^"]*"', "", attrs)
                if isinstance(v, str) and v.startswith("#"):
                    attrs += ' t="e"'
                    vt = v
                elif isinstance(v, str):
                    attrs += ' t="str"'
                    vt = v
                else:
                    vt = repr(float(v)) if isinstance(v, float) else str(v)
                return "<c%s><f>%s</f><v>%s</v></c>" % (attrs, m.group(3), vt)

            s = re.sub(r'<c((?:\s[^>]*?)?\sr="([A-Z]+[0-9]+)"[^>]*)><f>([^<]*)</f><v\s*/?>(?:</v>)?</c>', rep, s)
            b = s.encode("utf-8")
        out.append((n, b))
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, b in out:
            z.writestr(n, b)


def sheet_part(wb, title):
    return "xl/worksheets/sheet%d.xml" % ([ws.title for ws in wb.worksheets].index(title) + 1)


# ---------- 1, 2: insert and delete a block (formulas rewritten as Excel would) ----------
def base_row(n, label_n):
    return ["r%d" % label_n, label_n * 1.5, "=B%d*2" % n, label_n % 7, label_n % 11, label_n, label_n * 3, "=SUM(B%d:C%d)" % (n, n)]


def data_sheet(ws, labels):
    ws.append(["label", "value", "double", "a", "b", "c", "d", "sum"])
    for i, lab in enumerate(labels):
        ws.append(base_row(i + 2, lab))


def insert_block():
    wb = new_wb(); ws = wb.active; ws.title = "Data"
    data_sheet(ws, list(range(2, 951)))
    save(wb, "insert-block-before.xlsx")
    wb = new_wb(); ws = wb.active; ws.title = "Data"
    labels = list(range(2, 935)) + list(range(5000, 5316)) + list(range(935, 951))
    data_sheet(ws, labels)
    save(wb, "insert-block-after.xlsx")


def delete_block():
    wb = new_wb(); ws = wb.active; ws.title = "Data"
    data_sheet(ws, list(range(2, 951)))
    save(wb, "delete-block-before.xlsx")
    wb = new_wb(); ws = wb.active; ws.title = "Data"
    data_sheet(ws, [n for n in range(2, 951) if not (400 <= n <= 449)])
    save(wb, "delete-block-after.xlsx")


# ---------- 3: filled-down pattern with exceptions (with caches) ----------
def pattern_exception():
    def build(after):
        wb = new_wb(); ws = wb.active; ws.title = "Calc"
        ws.append(["a", "b"] + (["c"] if after else []))
        cache = {}
        for n in range(2, 2002):
            a, b = n, (n * 7) % 101 + 1
            row = [a, b]
            if after:
                if n == 1200:
                    f, v = "=B%d*3" % n, b * 3
                elif n == 1500:
                    f, v = 7, None
                elif n == 40:
                    f, v = "=B%d/0" % n, "#DIV/0!"
                elif n == 2001:
                    f, v = "=B%d*2+1" % n, b * 2 + 1
                else:
                    f, v = "=B%d*2" % n, b * 2
                row.append(f)
                if v is not None:
                    cache["C%d" % n] = v
            ws.append(row)
        save(wb, "pattern-exception-%s.xlsx" % ("after" if after else "before"), {"xl/worksheets/sheet1.xml": cache} if after else None)
    build(False); build(True)


# ---------- 4: sort plus one edit ----------
def sort_fixture():
    rows = [(i, (i * 37) % 503, "item %d" % i) for i in range(1, 501)]
    wb = new_wb(); ws = wb.active; ws.title = "List"
    ws.append(["id", "key", "name"])
    for r in rows: ws.append(list(r))
    save(wb, "sort-before.xlsx")
    wb = new_wb(); ws = wb.active; ws.title = "List"
    ws.append(["id", "key", "name"])
    for r in sorted(rows, key=lambda r: r[1]):
        ws.append([r[0], r[1], "EDITED" if r[0] == 250 else r[2]])
    save(wb, "sort-after.xlsx")


# ---------- 5: chart removed on an openpyxl load and save ----------
def chart_removed():
    wb = new_wb(); ws = wb.active; ws.title = "Data"
    ws.append(["x", "y"])
    for n in range(2, 42): ws.append([n, n * n])
    ch = LineChart(); ch.title = "Squares"
    ch.add_data(Reference(ws, min_col=2, min_row=1, max_row=41), titles_from_data=True)
    ws.add_chart(ch, "E2")
    save(wb, "chart-removed-before.xlsx")
    wb2 = openpyxl.load_workbook(os.path.join(OUT, "chart-removed-before.xlsx"))
    # openpyxl 3.1.5 keeps a chart it reads back, so the agent's script removes it, as a rewrite that drops the drawing would
    wb2["Data"]._charts = []
    wb2["Data"]["B10"] = 12345
    save(wb2, "chart-removed-after.xlsx")


# ---------- 6: hidden row, column and sheet ----------
def hidden_row():
    def build(after):
        wb = new_wb(); ws = wb.active; ws.title = "Main"
        for n in range(1, 61): ws.append(["m%d" % n, n, n * 2, n * 3, n * 4, n * 5])
        ws.row_dimensions[20].hidden = True
        ws.column_dimensions["D"].hidden = True
        sec = wb.create_sheet("Secret"); sec.sheet_state = "hidden"
        for n in range(1, 6): sec.append(["s%d" % n, n])
        if after:
            ws["B20"] = 999; ws["D5"] = 888; sec["A1"] = "changed"; ws["B30"] = 777
        save(wb, "hidden-row-%s.xlsx" % ("after" if after else "before"))
    build(False); build(True)


# ---------- 7: created workbook ----------
def created():
    open(os.path.join(OUT, "created-before.xlsx"), "wb").close()
    wb = new_wb(); ws = wb.active; ws.title = "GDP"
    ws.append(["date", "gdp", "growth", "level"])
    for n in range(2, 951): ws.append(["%d-%02d-01" % (1947 + (n - 2) // 4, ((n - 2) % 4) * 3 + 1), 2000 + n * 3.5, "=B%d/B%d-1" % (n, max(2, n - 1)), n * 10])
    c = wb.create_sheet("CPI"); c.append(["date", "cpi", "x"])
    for n in range(2, 901): c.append(["m%d" % n, 20 + n * 0.25, "=B%d*2" % n])
    t = wb.create_sheet("Notes")
    for n in range(1, 21): t.append(["note %d" % n, "text %d" % n])
    save(wb, "created-after.xlsx")


# ---------- 8: renamed sheet ----------
def renamed_sheet():
    def build(after):
        wb = new_wb(); s = wb.active; s.title = "Summary"
        inp = wb.create_sheet("Inputs" if after else "Input")
        nm = "Inputs" if after else "Input"
        for n in range(1, 21):
            inp.append(["in%d" % n, n * 10 if not (after and n == 5) else 555])
            s.append(["sum%d" % n, "=%s!B%d*2" % (nm, n)])
        save(wb, "renamed-sheet-%s.xlsx" % ("after" if after else "before"))
    build(False); build(True)


# ---------- 9: recalculation cascade (with caches) ----------
def recalc_cascade():
    def build(after):
        rate = 0.07 if after else 0.05
        wb = new_wb(); a = wb.active; a.title = "Assumptions"
        a["A1"] = "rate"; a["B1"] = rate
        c = wb.create_sheet("Calc"); c.append(["n", "value", "noise"])
        cache = {}
        for n in range(2, 502):
            c.append([n, "=A%d*(1+Assumptions!$B$1)" % n, "=RAND()" if n == 2 else None])
            cache["B%d" % n] = n * (1 + rate)
        cache["C2"] = 0.25 if after else 0.75
        save(wb, "recalc-cascade-%s.xlsx" % ("after" if after else "before"), {"xl/worksheets/sheet2.xml": cache})
    build(False); build(True)


# ---------- 10: scattered edits ----------
def scattered():
    def build(after):
        wb = new_wb(); ws = wb.active; ws.title = "Ledger"
        ws.append(["id", "a", "b", "amt", "e", "f", "g", "h", "i", "j", "k"])
        for n in range(2, 600):
            amt = n * 2
            if after and n >= 10 and n <= 598 and (n - 10) % 3 == 0: amt += 1
            row = [n, n % 5, n % 9, amt, n, n, n, n * 10, n * 11, n * 12, n * 13]
            if after and 200 <= n <= 204: row[7:11] = [-1, -2, -3, -4]
            ws.append(row)
        ws["D600"] = "=SUM(D2:D598)" if after else "=SUM(D2:D599)"
        save(wb, "scattered-%s.xlsx" % ("after" if after else "before"))
    build(False); build(True)


# ---------- 11: wide row edit ----------
def wide():
    def build(after):
        wb = new_wb(); ws = wb.active; ws.title = "Wide"
        for r in range(1, 31):
            ws.append([("x%d" % r) if c == 1 else (r * 100 + c + (1000 if after and r == 5 and c >= 2 else 0)) for c in range(1, 53)])
        save(wb, "wide-%s.xlsx" % ("after" if after else "before"))
    build(False); build(True)


# ---------- 12: single edit ----------
def single_edit():
    def build(after):
        wb = new_wb(); ws = wb.active; ws.title = "Sheet1"
        for r in range(1, 101): ws.append([r, r * 2, ("changed" if after and r == 50 else r * 3), r * 4, r * 5])
        save(wb, "single-edit-%s.xlsx" % ("after" if after else "before"))
    build(False); build(True)


# ---------- 13: NWDATA-like ----------
def nwdata():
    def build(after):
        wb = new_wb(); gdp = wb.active; gdp.title = "GDP"
        gdp.append(["observation_date", "GDP", "yoy", "level"])
        last = 963 if after else 951
        for n in range(2, last + 1):
            q = n - 2
            date = "%d-%02d-01" % (1947 + q // 12, q % 12 + 1)
            if n >= 6:
                yoy = "=(B%d/B%d-1)*100" % (n, n - 4) if after else "=B%d/B%d-1" % (n, n - 4)
            else:
                yoy = None
            gdp.append([date, round(243.1 + q * 1.37 + (q % 7) * 0.4, 3), yoy, "=B%d*1000" % n])
        cpi = wb.create_sheet("CPI"); cpi.append(["observation_date", "NWCPI"])
        for n in range(2, 902): cpi.append(["%d-%02d-01" % (1950 + (n - 2) // 12, (n - 2) % 12 + 1), round(23.5 + n * 0.31, 3)])
        un = wb.create_sheet("Unemployment"); un.append(["observation_date", "NWUNEMP"])
        for n in range(2, 302): un.append(["%d-%02d-01" % (2000 + (n - 2) // 12, (n - 2) % 12 + 1), 9.9 if (after and n == 150) else round(4 + (n % 23) * 0.1, 1)])
        cs = wb.create_chartsheet("Chart", 0)
        ch = LineChart(); ch.title = "GDP"
        ch.add_data(Reference(gdp, min_col=2, min_row=1, max_row=951), titles_from_data=True)
        cs.add_chart(ch)
        save(wb, "nwdata-%s.xlsx" % ("after" if after else "before"))
    build(False); build(True)


# ---------- 14: deletion at the end, and a sheet emptied ----------
def delete_end():
    def build(after):
        wb = new_wb(); ws = wb.active; ws.title = "Data"
        for n in range(1, (250 if after else 301)): ws.append([n, n * 2, "=A%d+B%d" % (n, n)])
        old = wb.create_sheet("Old")
        if not after:
            for n in range(1, 21): old.append(["old %d" % n, n])
        save(wb, "delete-end-%s.xlsx" % ("after" if after else "before"))
    build(False); build(True)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for f in [insert_block, delete_block, pattern_exception, sort_fixture, chart_removed, hidden_row, created, renamed_sheet, recalc_cascade, scattered, wide, single_edit, nwdata, delete_end]:
        f()
    for n in sorted(os.listdir(OUT)):
        print("%8d %s" % (os.path.getsize(os.path.join(OUT, n)), n))
