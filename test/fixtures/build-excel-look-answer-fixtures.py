"""Builds the workbook pairs for answerExcel's route tests (test/fixtures/excel-look/answer-<id>-before.xlsx, -after.xlsx).

"gdp": one edit at GDP!F7 (the first sheet, the one Excel opens on). "both": GDP!M20 and GDP2!F7 (a second sheet, which Excel does not open on, shaped like the first).
Rerun from the repo root:  python3 test/fixtures/build-excel-look-answer-fixtures.py
"""
import datetime
import os

import openpyxl

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "excel-look")
FIXED = datetime.datetime(2026, 11, 11, 12, 0, 0)


def book(edits):
    wb = openpyxl.Workbook()
    g = wb.active
    g.title = "GDP"
    o = wb.create_sheet("GDP2")
    for r in range(1, 41):
        for c in range(4, 25):
            g.cell(row=r, column=c, value=r * 100 + c)
        for c in range(4, 25):
            o.cell(row=r, column=c, value=r * 10 + c)
    for sheet, addr, v in edits:
        wb[sheet][addr] = v
    wb.properties.created = FIXED
    wb.properties.modified = FIXED
    return wb


for name, edits in (("gdp", [("GDP", "F7", 99999)]), ("both", [("GDP", "F7", 99999), ("GDP2", "F7", 777)])):
    book([]).save(os.path.join(OUT, f"answer-{name}-before.xlsx"))
    book(edits).save(os.path.join(OUT, f"answer-{name}-after.xlsx"))
