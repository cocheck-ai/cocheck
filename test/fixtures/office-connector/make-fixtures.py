# Fresh fixtures for test/office-connector.test.ts: one workbook, document and deck in two versions (v1 -> v2 is one edit each).
# Run from this folder: python3 make-fixtures.py (needs openpyxl, python-docx, python-pptx). Synthetic content only.
import openpyxl, docx, pptx
for v, val in ((1, "Widget"), (2, "Gizmo")):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Sheet1"
    ws["A1"] = "Item"; ws["B1"] = "Qty"; ws["A2"] = val; ws["B2"] = 2 if v == 1 else 3; ws["B3"] = "=B2*2"
    wb.save(f"v{v}.xlsx")
    d = docx.Document(); d.add_paragraph("Quarterly notes"); d.add_paragraph(f"The {val} ships in May."); d.save(f"v{v}.docx")
    p = pptx.Presentation(); s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = f"Launch plan for {val}"; p.save(f"v{v}.pptx")
# The .xlsm fixtures (scripts/live-office-check.ts `xlsm`): budget.xlsm is v1.xlsx and v2.xlsm is v2.xlsx with the workbook part's content type set to
# macroEnabled.main (no VBA part). Same zip, one [Content_Types].xml override changed.
import zipfile
_OLD = b"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
_NEW = b"application/vnd.ms-excel.sheet.macroEnabled.main+xml"
for _src, _dst in (("v1.xlsx", "budget.xlsm"), ("v2.xlsx", "v2.xlsm")):
    _zi = zipfile.ZipFile(_src)
    with zipfile.ZipFile(_dst, "w", zipfile.ZIP_DEFLATED) as _zo:
        for _i in _zi.infolist():
            _d = _zi.read(_i.filename)
            if _i.filename == "[Content_Types].xml": _d = _d.replace(_OLD, _NEW)
            _zo.writestr(_i, _d)
