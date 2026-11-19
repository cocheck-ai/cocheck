#!/usr/bin/env python3
"""Builds the 17 neutral workbook snapshots in test/fixtures/probe and test/fixtures/casebook-rerun.

Run from the repo root:  python3 -I test/fixtures/build-neutral-workbooks.py

The snapshots stand in for the states of one workbook through two agent runs (S0 base, S1 the agent edits sheet XML
directly so nothing recalculates, S2 Excel saves after a hand edit of Inputs!B31 and recalculates, S3 the agent adds a
Sensitivity sheet, S4 one more log row). Everything here is CoCheck's own: an invented "Acme Components" model with
made-up numbers and labels. No third-party workbook content is used.

The files are written as raw OOXML (zipfile only, no third-party library) so the generator controls what the tests
read: shared formulas, formula cells with cached values (stale in S1 and S3-style agent edits, recalculated in
Excel-saved states), string results, quoted sheet names with an ampersand, a 1904 date system, percent and currency
number formats, inline strings in agent-written parts, and namespace-prefixed XML for the Codex rewrite (S1, S1b).
Cached values come from the Python mirror of each formula below, not from Excel.
"""
from __future__ import annotations

import io
import math
import os
import random
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
FIXED_DATE = (1980, 1, 2, 19, 0, 0)

# style ids (cellXfs index)
GEN, PCT, USD, DATE, INT, BOLD = 0, 1, 2, 3, 4, 5

INPUTS = "Inputs"
MODEL = "Model"
SHEET_NAMES = [
    "Read me", INPUTS, MODEL, "Summary", "Normalizer", "R&D calc", "Lease calc", "Scenarios", "Option calc",
    "Capital cost", "Ratings table", "Region averages A", "Region averages B", "Country table", "Trailing figures", "Answers",
]


def col_letter(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def col_num(s: str) -> int:
    n = 0
    for ch in s:
        n = n * 26 + ord(ch) - 64
    return n


def split_addr(a: str) -> tuple[str, int]:
    m = re.fullmatch(r"([A-Z]+)(\d+)", a)
    return m.group(1), int(m.group(2))


class Cell:
    __slots__ = ("kind", "value", "formula", "fn", "style", "shared")

    def __init__(self, kind, value=None, formula=None, fn=None, style=GEN, shared=None):
        self.kind, self.value, self.formula, self.fn, self.style, self.shared = kind, value, formula, fn, style, shared


class Sheet:
    def __init__(self, name: str):
        self.name = name
        self.cells: dict[str, Cell] = {}
        self.groups: list[tuple[int, str]] = []  # (si, ref) for shared formulas

    def const(self, addr: str, value, style=GEN):
        self.cells[addr] = Cell("s" if isinstance(value, str) else "n", value=value, style=style)

    def formula(self, addr: str, text: str, fn, style=GEN):
        self.cells[addr] = Cell("f", formula=text, fn=fn, style=style)

    def fill(self, first: str, last: str, text, fn, style=GEN):
        """One shared formula over a row or column range; text(col, row) and fn(col, row) give each cell's own spelling."""
        c1, r1 = split_addr(first)
        c2, r2 = split_addr(last)
        si = len(self.groups)
        self.groups.append((si, f"{first}:{last}"))
        for r in range(r1, r2 + 1):
            for c in range(col_num(c1), col_num(c2) + 1):
                a = f"{col_letter(c)}{r}"
                shared = (si, a == first)
                cc, rr = col_letter(c), r
                self.cells[a] = Cell("f", formula=text(cc, rr), fn=(lambda g, cc=cc, rr=rr: fn(g, cc, rr)), style=style, shared=shared)


def prev_col(c: str) -> str:
    return col_letter(col_num(c) - 1)


def build_book() -> dict[str, Sheet]:
    rnd = random.Random(20261106)
    sheets = {n: Sheet(n) for n in SHEET_NAMES}

    # --- Read me
    s = sheets["Read me"]
    s.const("A1", "Acme Components sandbox model", BOLD)
    lines = [
        "An invented valuation sandbox used as a test fixture. Every name and number here is made up.",
        "Change the inputs on the Inputs sheet; the Model sheet projects six years of cash flow and values one share.",
        "Yellow cells are inputs. Everything else is a formula or reference data.",
        "Region averages A and B hold made-up reference tables. Country table holds a made-up risk table.",
        "Scenarios, Option calc and Capital cost read a few inputs; Normalizer, R&D calc and Lease calc do not.",
    ]
    for i, t in enumerate(lines):
        s.const(f"A{3 + i}", t)
    for r in range(9, 23):
        s.const(f"A{r}", f"Note {r - 8}: reference text line for the sandbox workbook")
        s.const(f"F{r}", r * 3)

    # --- Inputs
    s = sheets[INPUTS]
    labels = {
        1: "Inputs for the Acme Components sandbox", 3: "Date of the inputs", 5: "Company", 6: "Capitalize R&D?",
        7: "Capitalize leases?", 8: "Normalize earnings?", 9: "Country", 10: "Shares outstanding (millions)",
        11: "Debt (millions)", 12: "Operating income (millions)", 13: "Interest expense (millions)", 14: "Cash (millions)",
        15: "Minority interests (millions)", 17: "Marginal tax rate", 18: "Current revenues (millions)",
        19: "Operating margin", 20: "Base year growth", 21: "Growth rate in high-growth years", 22: "Reinvestment rate",
        31: "Current share price", 33: "Market capitalization (millions)", 39: "Long-term riskfree rate",
        40: "Levered beta", 41: "Equity risk premium", 43: "Cost of equity", 46: "Pre-tax cost of debt",
        47: "After-tax cost of debt", 58: "Length of high growth period (years)",
    }
    for r in range(1, 88):
        s.const(f"A{r}", labels.get(r, f"Reference input {r}"), BOLD if r == 1 else GEN)
    s.const("B3", 45000, DATE)
    s.const("B5", "Acme Components")
    s.const("B6", "Yes")
    s.const("B7", "No")
    s.const("B8", "No")
    s.const("B9", "Ruritania")
    s.const("B10", 1250.5)
    s.const("B11", 6150)
    s.const("B12", 4800)
    s.const("B13", 310)
    s.const("B14", 2200)
    s.const("B15", 0)
    s.const("B17", 0.25, PCT)
    s.const("B18", 34124, USD)
    s.const("B19", 0.18, PCT)
    s.const("B20", 0.06, PCT)
    s.const("B21", 0.08, PCT)
    s.const("B22", 0.3, PCT)
    s.const("B31", 804.14, USD)
    s.formula("B33", "B31*B10", lambda g: g(INPUTS, "B31") * g(INPUTS, "B10"), USD)
    s.const("B39", 0.045, PCT)
    s.const("B40", 1.1)
    s.const("B41", 0.055, PCT)
    s.formula("B43", "B39+B40*B41", lambda g: g(INPUTS, "B39") + g(INPUTS, "B40") * g(INPUTS, "B41"), PCT)
    s.const("B46", 0.0509, PCT)
    s.formula("B47", "B46*(1-B17)", lambda g: g(INPUTS, "B46") * (1 - g(INPUTS, "B17")), PCT)
    s.const("B58", 10)
    fixed = {f"B{r}" for r in (3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 31, 33, 39, 40, 41, 43, 46, 47, 58)}
    for r in range(2, 88):
        if f"B{r}" in fixed or r == 1:
            continue
        s.const(f"B{r}", round(rnd.uniform(1, 500), 2))
    for r in range(2, 88):
        s.const(f"C{r}", "millions" if r % 3 else "percent")
        if r % 7 == 0:
            s.const(f"F{r}", r * 11)

    # --- Model: six projection years in C..H, value per share in F73
    s = sheets[MODEL]
    cols = ["C", "D", "E", "F", "G", "H"]
    s.const("A1", "Item", BOLD)
    s.const("B1", "Base year", BOLD)
    for i, c in enumerate(cols, 1):
        s.const(f"{c}1", i)
    for r, t in {2: "Revenue growth", 3: "Revenue", 4: "Operating margin", 5: "Operating income", 6: "Tax", 7: "After-tax operating income",
                 8: "Reinvestment", 9: "Free cash flow", 10: "Cost of capital", 11: "Discount factor", 12: "Present value"}.items():
        s.const(f"A{r}", t)
    I = INPUTS
    s.fill("C2", "H2", lambda c, r: f"IF({c}$1<=Inputs!$B$58,Inputs!$B$21,Inputs!$B$39)",
           lambda g, c, r: g(I, "B21") if g(MODEL, f"{c}1") <= g(I, "B58") else g(I, "B39"), PCT)
    s.formula("B3", "Inputs!B18", lambda g: g(I, "B18"), USD)
    s.fill("C3", "H3", lambda c, r: f"{prev_col(c)}3*(1+{c}2)", lambda g, c, r: g(MODEL, f"{prev_col(c)}3") * (1 + g(MODEL, f"{c}2")), USD)
    s.fill("C4", "H4", lambda c, r: "Inputs!$B$19", lambda g, c, r: g(I, "B19"), PCT)
    s.fill("C5", "H5", lambda c, r: f"{c}3*{c}4", lambda g, c, r: g(MODEL, f"{c}3") * g(MODEL, f"{c}4"), USD)
    s.fill("C6", "H6", lambda c, r: f"{c}5*Inputs!$B$17", lambda g, c, r: g(MODEL, f"{c}5") * g(I, "B17"), USD)
    s.fill("C7", "H7", lambda c, r: f"{c}5-{c}6", lambda g, c, r: g(MODEL, f"{c}5") - g(MODEL, f"{c}6"), USD)
    s.fill("C8", "H8", lambda c, r: f"{c}7*Inputs!$B$22", lambda g, c, r: g(MODEL, f"{c}7") * g(I, "B22"), USD)
    s.fill("C9", "H9", lambda c, r: f"{c}7-{c}8", lambda g, c, r: g(MODEL, f"{c}7") - g(MODEL, f"{c}8"), USD)
    wacc = lambda g: (g(I, "B33") / (g(I, "B33") + g(I, "B11")) * g(I, "B43") + g(I, "B11") / (g(I, "B33") + g(I, "B11")) * g(I, "B47"))
    s.fill("C10", "H10", lambda c, r: "Inputs!$B$33/(Inputs!$B$33+Inputs!$B$11)*Inputs!$B$43+Inputs!$B$11/(Inputs!$B$33+Inputs!$B$11)*Inputs!$B$47",
           lambda g, c, r: wacc(g), PCT)
    s.formula("C11", "1/(1+C10)", lambda g: 1 / (1 + g(MODEL, "C10")))
    s.fill("D11", "H11", lambda c, r: f"{prev_col(c)}11/(1+{c}10)", lambda g, c, r: g(MODEL, f"{prev_col(c)}11") / (1 + g(MODEL, f"{c}10")))
    s.fill("C12", "H12", lambda c, r: f"{c}9*{c}11", lambda g, c, r: g(MODEL, f"{c}9") * g(MODEL, f"{c}11"), USD)
    for r in range(14, 66):
        s.const(f"A{r}", f"Assumption note {r - 13}")
        if r % 4 == 0:
            s.const(f"B{r}", r * 7)
    for r, t in {66: "Sum of present values", 67: "Terminal value", 68: "Present value of terminal value", 69: "Operating assets",
                 70: "Debt", 71: "Cash", 72: "Equity value", 73: "Estimated value per share"}.items():
        s.const(f"A{r}", t, BOLD if r == 73 else GEN)
    pv = lambda g: sum(g(MODEL, f"{c}12") for c in cols)
    s.formula("F66", "SUM(C12:H12)", pv, USD)
    s.formula("F67", "H9*(1+Inputs!B39)/(H10-Inputs!B39)", lambda g: g(MODEL, "H9") * (1 + g(I, "B39")) / (g(MODEL, "H10") - g(I, "B39")), USD)
    s.formula("F68", "F67*H11", lambda g: g(MODEL, "F67") * g(MODEL, "H11"), USD)
    s.formula("F69", "F66+F68", lambda g: g(MODEL, "F66") + g(MODEL, "F68"), USD)
    s.formula("F70", "Inputs!B11", lambda g: g(I, "B11"), USD)
    s.formula("F71", "Inputs!B14", lambda g: g(I, "B14"), USD)
    s.formula("F72", "F69-F70+F71", lambda g: g(MODEL, "F69") - g(MODEL, "F70") + g(MODEL, "F71"), USD)
    s.formula("F73", "F72/Inputs!B10", lambda g: g(MODEL, "F72") / g(I, "B10"), USD)
    s.formula("H70", 'IF(F72/Inputs!B10>Inputs!B31,"Above price","Below price")', lambda g: "Above price" if g(MODEL, "F72") / g(I, "B10") > g(I, "B31") else "Below price")
    s.const("S73", 1)

    # --- Summary
    s = sheets["Summary"]
    s.const("A1", "Summary", BOLD)
    s.const("A2", "Model value per share")
    s.const("A3", "Price")
    s.const("A4", "Difference")
    s.const("A5", "Verdict")
    s.formula("B2", "Model!F72/Inputs!B10", lambda g: g(MODEL, "F72") / g(I, "B10"), USD)
    s.formula("B3", "Inputs!B31", lambda g: g(I, "B31"), USD)
    s.formula("B4", "B2/B3-1", lambda g: g("Summary", "B2") / g("Summary", "B3") - 1, PCT)
    s.formula("B5", 'IF(B2>B3,"Model above price","Model below price")', lambda g: "Model above price" if g("Summary", "B2") > g("Summary", "B3") else "Model below price")
    s.const("D2", "from the Model sheet")

    # --- Normalizer (reads Inputs!B8 and B12, neither edited)
    s = sheets["Normalizer"]
    s.const("A1", "Earnings adjustment", BOLD)
    for r in range(2, 22):
        s.const(f"A{r}", f"Year {r - 1}")
        s.const(f"B{r}", round(rnd.uniform(500, 900), 1))
        s.const(f"C{r}", round(rnd.uniform(40, 90), 1))
    s.fill("D2", "D21", lambda c, r: f'IF(Inputs!$B$8="Yes",B{r}-C{r},B{r})', lambda g, c, r: g("Normalizer", f"B{r}") - g("Normalizer", f"C{r}") if g(I, "B8") == "Yes" else g("Normalizer", f"B{r}"))
    s.formula("E2", "AVERAGE(D2:D21)", lambda g: sum(g("Normalizer", f"D{r}") for r in range(2, 22)) / 20)
    s.formula("G2", "MAX(D2:D21)", lambda g: max(g("Normalizer", f"D{r}") for r in range(2, 22)))

    # --- R&D calc and Lease calc: formulas that read Inputs!B6 / B7 only
    s = sheets["R&D calc"]
    s.const("A1", "R&D worksheet", BOLD)
    for r in range(2, 143):
        s.const(f"A{r}", f"Row {r - 1}")
        for c in "BCD":
            s.const(f"{c}{r}", round(rnd.uniform(1, 90), 2))
    s.fill("E2", "E142", lambda c, r: f'IF(Inputs!$B$6="Yes",B{r}+C{r},B{r})', lambda g, c, r: g("R&D calc", f"B{r}") + g("R&D calc", f"C{r}") if g(I, "B6") == "Yes" else g("R&D calc", f"B{r}"))
    s.fill("F2", "F142", lambda c, r: f"ROUND(E{r}*D{r},2)", lambda g, c, r: round(g("R&D calc", f"E{r}") * g("R&D calc", f"D{r}"), 2))
    s.formula("J2", "SUM(F2:F142)", lambda g: sum(g("R&D calc", f"F{r}") for r in range(2, 143)))
    s = sheets["Lease calc"]
    s.const("A1", "Lease worksheet", BOLD)
    for r in range(2, 36):
        s.const(f"A{r}", f"Lease {r - 1}")
        s.const(f"B{r}", round(rnd.uniform(10, 300), 1))
        s.const(f"C{r}", rnd.randint(1, 12))
    s.fill("D2", "D35", lambda c, r: f'IF(Inputs!$B$7="Yes",B{r}*C{r},0)', lambda g, c, r: g("Lease calc", f"B{r}") * g("Lease calc", f"C{r}") if g(I, "B7") == "Yes" else 0)
    s.formula("K2", "SUM(D2:D35)", lambda g: sum(g("Lease calc", f"D{r}") for r in range(2, 36)))

    # --- Scenarios: 8 formulas read Inputs!B18
    s = sheets["Scenarios"]
    s.const("A1", "Scenario", BOLD)
    s.const("B1", "Growth", BOLD)
    s.const("C1", "Margin", BOLD)
    s.const("D1", "Revenue in year 5", BOLD)
    for r in range(2, 32):
        s.const(f"A{r}", f"Scenario {r - 1}")
        s.const(f"B{r}", round(0.02 + 0.005 * r, 3), PCT)
        s.const(f"C{r}", round(0.10 + 0.004 * r, 3), PCT)
        s.const(f"F{r}", r)
    s.fill("D2", "D9", lambda c, r: f"Inputs!$B$18*(1+B{r})^5", lambda g, c, r: g(I, "B18") * (1 + g("Scenarios", f"B{r}")) ** 5, USD)

    # --- Option calc: 9 formulas read Inputs!B31 and B39
    s = sheets["Option calc"]
    for c, t in zip("ABCDE", ["Option", "Strike", "d1", "d2", "Value"]):
        s.const(f"{c}1", t, BOLD)
    for r in range(2, 28):
        s.const(f"A{r}", f"Option {r - 1}")
        s.const(f"B{r}", 600 + 100 * r if r < 5 else r * 3)
    ncdf = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
    s.fill("C2", "C4", lambda c, r: f"(LN(Inputs!$B$31/B{r})+(Inputs!$B$39+0.04))/0.2", lambda g, c, r: (math.log(g(I, "B31") / g("Option calc", f"B{r}")) + g(I, "B39") + 0.04) / 0.2)
    s.fill("D2", "D4", lambda c, r: f"C{r}-0.2", lambda g, c, r: g("Option calc", f"C{r}") - 0.2)
    s.fill("E2", "E4", lambda c, r: f"Inputs!$B$31*NORMSDIST(C{r})-B{r}*EXP(-Inputs!$B$39)*NORMSDIST(D{r})",
           lambda g, c, r: g(I, "B31") * ncdf(g("Option calc", f"C{r}")) - g("Option calc", f"B{r}") * math.exp(-g(I, "B39")) * ncdf(g("Option calc", f"D{r}")), USD)

    # --- Ratings table (reference data) and Capital cost: 8 formulas read Inputs!B39 and B17
    s = sheets["Ratings table"]
    for c, t in zip("ABCD", ["Coverage from", "Rating", "Spread", "Note"]):
        s.const(f"{c}1", t, BOLD)
    for r in range(2, 54):
        s.const(f"A{r}", round(-2 + 0.5 * (r - 2), 2))
        s.const(f"B{r}", "AAA" if r > 40 else "BBB" if r > 20 else "CCC")
        s.const(f"C{r}", round(0.01 + 0.0004 * (54 - r), 4), PCT)
        s.const(f"D{r}", "reference")
        for c in "EFGHIJKLMNOP":
            if r % 5 == 0:
                s.const(f"{c}{r}", round(rnd.uniform(0, 1), 3))
    s = sheets["Capital cost"]
    for c, t in zip("ABCDEF", ["Case", "Debt", "Interest", "Coverage", "Pre-tax cost of debt", "After-tax cost of debt"]):
        s.const(f"{c}1", t, BOLD)
    for r in range(2, 65):
        s.const(f"A{r}", f"Case {r - 1}")
        s.const(f"B{r}", 1000 + 150 * r)
        s.const(f"C{r}", 40 + 3 * r)
        for c in "GHIJKLMNOPQ":
            if r % 6 == 0:
                s.const(f"{c}{r}", round(rnd.uniform(0, 2), 3))
    rt = lambda cov: next((0.01 + 0.0004 * (54 - rr) for rr in range(53, 1, -1) if -2 + 0.5 * (rr - 2) <= cov), 0.0)
    s.fill("D2", "D5", lambda c, r: f"B{r}/C{r}", lambda g, c, r: g("Capital cost", f"B{r}") / g("Capital cost", f"C{r}"))
    s.fill("E2", "E5", lambda c, r: f"Inputs!$B$39+VLOOKUP(D{r},'Ratings table'!$A$2:$C$53,3,TRUE)", lambda g, c, r: g(I, "B39") + rt_exact(g("Capital cost", f"D{r}")), PCT)
    s.fill("F2", "F5", lambda c, r: f"E{r}*(1-Inputs!$B$17)", lambda g, c, r: g("Capital cost", f"E{r}") * (1 - g(I, "B17")), PCT)

    # --- Region averages A / B, Country table, Trailing figures, Answers: reference data
    for name, seed in (("Region averages A", 1), ("Region averages B", 2)):
        s = sheets[name]
        r2 = random.Random(seed)
        for c in range(1, 28):
            s.const(f"{col_letter(c)}1", f"Metric {c}", BOLD)
        for r in range(2, 98):
            s.const(f"A{r}", f"Sector {r - 1}")
            for c in range(2, 28):
                s.const(f"{col_letter(c)}{r}", round(r2.uniform(0, 5), 4))
    s = sheets["Country table"]
    for c, t in zip("ABCDEF", ["Country", "Rating", "Default spread", "Weight", "Premium", "Adjusted premium"]):
        s.const(f"{c}1", t, BOLD)
    for r in range(2, 229):
        s.const(f"A{r}", f"Country {r - 1}")
        s.const(f"B{r}", "Aa" if r % 3 else "Baa")
        s.const(f"C{r}", round(0.002 * (r % 17), 4), PCT)
        s.const(f"D{r}", round(0.5 + (r % 9) / 10, 2))
        s.const(f"E{r}", round(0.04 + 0.001 * (r % 23), 4), PCT)
    s.fill("F2", "F228", lambda c, r: f"ROUND(E{r}*D{r}+C{r},4)", lambda g, c, r: round(g("Country table", f"E{r}") * g("Country table", f"D{r}") + g("Country table", f"C{r}"), 4), PCT)
    s = sheets["Trailing figures"]
    for r in range(1, 23):
        s.const(f"A{r}", f"Quarter {r}")
        for c in "BCDE":
            s.const(f"{c}{r}", round(rnd.uniform(100, 1000), 1))
    for r in range(23, 102):  # 79 more reference cells, so the whole workbook reads as 9,387 cells like the snapshots the tests were pinned on
        s.const(f"A{r}", f"Quarter {r}")
    s = sheets["Answers"]
    for r in range(1, 17):
        s.const(f"A{r}", f"Question {r}")
        s.const(f"B{r}", "Yes" if r % 2 else "No")
        for c in "CDEFGHIJKL":
            s.const(f"{c}{r}", r * col_num(c))
    return sheets


def rt_exact(cov: float) -> float:
    """Mirror of VLOOKUP(cov, Ratings table A2:C53, 3, TRUE): the last row whose A is <= cov (A is ascending)."""
    best = None
    for r in range(2, 54):
        if round(-2 + 0.5 * (r - 2), 2) <= cov:
            best = round(0.01 + 0.0004 * (54 - r), 4)
    if best is None:
        raise ValueError("#N/A")
    return best


# ---------------------------------------------------------------- evaluation

def evaluate(sheets: dict[str, Sheet], overrides: dict[str, float]) -> dict[tuple[str, str], object]:
    memo: dict[tuple[str, str], object] = {}

    def g(sheet: str, addr: str):
        key = (sheet, addr)
        if key in memo:
            return memo[key]
        cell = sheets[sheet].cells.get(addr)
        if cell is None:
            return 0
        if cell.kind == "f":
            memo[key] = cell.fn(g)
        elif sheet == INPUTS and addr in overrides:
            memo[key] = overrides[addr]
        else:
            memo[key] = cell.value
        return memo[key]

    for sh in sheets.values():
        for a, c in sh.cells.items():
            if c.kind == "f":
                g(sh.name, a)
    return memo


# ---------------------------------------------------------------- xml writers

def num(v) -> str:
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    r = repr(float(v))
    return r[:-2] if r.endswith(".0") else r


class Strings:
    def __init__(self):
        self.items: list[str] = []
        self.index: dict[str, int] = {}

    def id(self, text: str) -> int:
        if text not in self.index:
            self.index[text] = len(self.items)
            self.items.append(text)
        return self.index[text]

    def xml(self, count: int) -> str:
        body = "".join(f"<si><t>{escape(t)}</t></si>" for t in self.items)
        return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="{NS_MAIN}" count="{count}" uniqueCount="{len(self.items)}">{body}</sst>'


def sheet_xml(sh: Sheet, values: dict, strings: Strings | None, edits: dict[str, float], excel: bool, widths: bool = True) -> tuple[str, int]:
    """One worksheet part. strings=None writes text as inline strings (an agent writing XML); otherwise shared strings."""
    rows: dict[int, list[tuple[int, str, Cell]]] = {}
    for a, c in sh.cells.items():
        col, r = split_addr(a)
        rows.setdefault(r, []).append((col_num(col), a, c))
    used = 0
    maxc = max(col_num(split_addr(a)[0]) for a in sh.cells)
    maxr = max(rows)
    out = []
    for r in sorted(rows):
        cells = []
        for _, a, c in sorted(rows[r]):
            st = f' s="{c.style}"' if c.style else ""
            if c.kind == "f":
                v = values[(sh.name, a)]
                if c.shared is not None:
                    si, master = c.shared
                    ref = dict(sh.groups)[si]
                    f = f'<f t="shared" ref="{ref}" si="{si}">{escape(c.formula)}</f>' if master else f'<f t="shared" si="{si}"/>'
                else:
                    f = f"<f>{escape(c.formula)}</f>"
                if isinstance(v, str):
                    cells.append(f'<c r="{a}"{st} t="str">{f}<v>{escape(v)}</v></c>')
                else:
                    cells.append(f'<c r="{a}"{st}>{f}<v>{num(v)}</v></c>')
            elif c.kind == "s":
                if strings is None:
                    cells.append(f'<c r="{a}"{st} t="inlineStr"><is><t>{escape(c.value)}</t></is></c>')
                else:
                    used += 1
                    cells.append(f'<c r="{a}"{st} t="s"><v>{strings.id(c.value)}</v></c>')
            else:
                v = edits.get(a, c.value) if sh.name == INPUTS else c.value
                cells.append(f'<c r="{a}"{st}><v>{num(v)}</v></c>')
        spans = f' spans="1:{maxc}"' if excel else ""
        out.append(f'<row r="{r}"{spans}>{"".join(cells)}</row>')
    colxml = f'<cols><col min="1" max="1" width="34" customWidth="1"/></cols>' if widths else ""
    xml = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="{NS_MAIN}" xmlns:r="{NS_REL}">'
        f'<dimension ref="A1:{col_letter(maxc)}{maxr}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
        f'<sheetFormatPr defaultRowHeight="15"/>{colxml}<sheetData>{"".join(out)}</sheetData></worksheet>'
    )
    return xml, used


def styles_xml() -> str:
    usd = escape('"$"#,##0.00_);[Red]\\("$"#,##0.00\\)', {'"': "&quot;"})
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="{NS_MAIN}">'
        f'<numFmts count="1"><numFmt numFmtId="164" formatCode="{usd}"/></numFmts>'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="6">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
        '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    )


def log_sheet(rows: list[list]) -> Sheet:
    sh = Sheet("Scenario log")
    for r, row in enumerate(rows, 1):
        for c, v in enumerate(row):
            if v is not None:
                sh.const(f"{col_letter(c + 1)}{r}", v)
    return sh


def sens_sheet(h: tuple[float, float, float]) -> Sheet:
    sh = Sheet("Sensitivity")
    for i, v in enumerate([0.02, 0.03, 0.04, 0.05, 0.06]):
        sh.const(f"A{2 + i}", v)
    for i, v in enumerate([0.07, 0.08, 0.09, 0.10, 0.11]):
        sh.const(f"{col_letter(2 + i)}1", v)
    for i, v in enumerate(h):
        sh.const(f"H{2 + i}", v)
    return sh


# ---------------------------------------------------------------- the states

EDIT5 = {"B17": 0.21, "B18": 36500, "B39": 0.043, "B46": 0.0525, "B58": 8}
OLD5 = {"B39": 0.045, "B17": 0.25, "B18": 34124, "B46": 0.0509, "B58": 10}
LOG_ORDER = ["B39", "B17", "B18", "B46", "B58"]
LOG_WHY = {
    "B39": "Long-term riskfree rate updated for scenario (requested 2026-10-07)",
    "B17": "Marginal tax rate updated for scenario (requested 2026-10-07)",
    "B18": "Current revenues updated for scenario (requested 2026-10-07)",
    "B46": "Pre-tax cost of debt updated for scenario (requested 2026-10-07)",
    "B58": "Length of high growth period (years) updated for scenario (requested 2026-10-07)",
}


def log_rows(leg: str, extra: str = "none", mc: tuple[float, float, float] = (0.05, 0.017105, 0.082895), s4: bool = False) -> list[list]:
    """The Scenario log rows each leg wrote. `extra`: none, rows7to11 (S3 and later)."""
    rows: list[list] = [["Cell", "Old value", "New value", "Reason"]]
    for a in LOG_ORDER:
        why = LOG_WHY[a] if leg != "codex" else LOG_WHY[a].replace("updated for scenario", "set for the scenario")
        rows.append([f"'{INPUTS}'!{a}", OLD5[a], EDIT5[a], why])
    if extra == "rows7to11":
        rows += [
            ["Sensitivity!A2:A6", "(empty - new sheet)", "0.02, 0.03, 0.04, 0.05, 0.06", "Step 9: growth-rate axis for sensitivity grid (plain values)"],
            ["Sensitivity!B1:F1", "(empty - new sheet)", "0.07, 0.08, 0.09, 0.10, 0.11", "Step 9: cost-of-capital axis for sensitivity grid (plain values)"],
            ["Sensitivity!H2", "(empty - new sheet)", mc[0], "Step 10: Monte Carlo mean revenue growth, N(0.05, 0.02), 347.3M draws, seed 20261008"],
            ["Sensitivity!H3", "(empty - new sheet)", mc[1], "Step 10: Monte Carlo 5th percentile revenue growth"],
            ["Sensitivity!H4", "(empty - new sheet)", mc[2], "Step 10: Monte Carlo 95th percentile revenue growth"],
        ]
        if leg == "codex":
            rows[7][3] = "Step 9: growth-rate axis for the sensitivity grid (plain values)"
    if s4:
        rows.append(["Backup", "(none)", "outside/casebook-backup.xlsx", "Step 13: backup of the round-3 workbook written outside the folder"])
    return rows


def package(sheets_all: list[Sheet], *, recalculated: bool, inputs_calc: dict, inputs_written: dict, excel: bool,
            agent_sheets: dict[str, str], variant: str, log_inline_rows: set[int] | None = None, dup_sheet_id: bool = False,
            prefixed: bool = False, modified: str) -> bytes:
    """sheets_all: the 16 base sheets, then Scenario log, then Sensitivity (those present).
    inputs_calc: Inputs values the cached results were computed from; inputs_written: Inputs values in the file.
    agent_sheets: name -> 'inline' (written by an agent as XML, no shared strings) or 'shared'."""
    base = [s for s in sheets_all if s.name in SHEET_NAMES]
    base_by = {s.name: s for s in base}
    values = evaluate(base_by, inputs_calc)
    parts: dict[str, str] = {}
    strings = Strings()
    count = 0
    n_sheets = len(sheets_all)
    sheet_files: dict[str, str] = {}
    for i, sh in enumerate(sheets_all, 1):
        fname = f"sheet{i}.xml"
        sheet_files[sh.name] = fname
        is_agent = sh.name not in SHEET_NAMES
        if is_agent:
            mode = agent_sheets[sh.name]
            if mode == "mixed":
                # Excel saved rows 1-6 (shared strings, spans); the agent then appended the rest as bare inline rows
                xml, used = mix_rows(sh, strings, log_inline_rows or set()), 0
            else:
                xml, used = sheet_xml(sh, {}, None if mode == "inline" else strings, {}, excel=(mode == "shared"), widths=False)
            count += used
            parts[f"xl/worksheets/{fname}"] = xml
        else:
            xml, used = sheet_xml(sh, values, strings, inputs_written, excel=excel)
            count += used
            parts[f"xl/worksheets/{fname}"] = xml
    # workbook.xml
    sheet_ids = {n: 10 + k for k, n in enumerate(SHEET_NAMES)}
    sheet_ids["Scenario log"] = 17 if dup_sheet_id else 19
    sheet_ids["Sensitivity"] = 20
    rids = {n: f"rId{i}" for i, n in enumerate([s.name for s in sheets_all], 1)}
    if "Sensitivity" in rids:
        rids["Sensitivity"] = "rId23"
    sheet_tags = "".join(f'<sheet name="{escape(s.name)}" sheetId="{sheet_ids.get(s.name, 30)}" r:id="{rids[s.name]}"/>' for s in sheets_all)
    # a base sheet id clash only when dup_sheet_id: give one base sheet id 17 (as Excel had)
    workbook = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="{NS_MAIN}" xmlns:r="{NS_REL}">'
        f'<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="10927"/><workbookPr date1904="1"/>'
        f'<bookViews><workbookView xWindow="0" yWindow="760" windowWidth="30240" windowHeight="18880" tabRatio="831" activeTab="1"/></bookViews>'
        f'<sheets>{sheet_tags}</sheets><calcPr calcId="191029" iterate="1"/></workbook>'
    )
    parts["xl/workbook.xml"] = workbook
    rel = [f'<Relationship Id="{rids[s.name]}" Type="{NS_REL}/worksheet" Target="worksheets/{sheet_files[s.name]}"/>' for s in sheets_all]
    rel.append(f'<Relationship Id="rId18" Type="{NS_REL}/styles" Target="styles.xml"/>')
    rel.append(f'<Relationship Id="rId19" Type="{NS_REL}/sharedStrings" Target="sharedStrings.xml"/>')
    rel.append(f'<Relationship Id="rId21" Type="{NS_REL}/calcChain" Target="calcChain.xml"/>')
    parts["xl/_rels/workbook.xml.rels"] = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{NS_PKG}">{"".join(rel)}</Relationships>'
    parts["_rels/.rels"] = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{NS_PKG}">'
        f'<Relationship Id="rId3" Type="{NS_REL}/extended-properties" Target="docProps/app.xml"/>'
        f'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        f'<Relationship Id="rId1" Type="{NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    )
    parts["xl/styles.xml"] = styles_xml()
    parts["xl/sharedStrings.xml"] = strings.xml(count)
    chain = "".join(f'<c r="{a}" i="{i}"/>' for i, sh in enumerate(sheets_all, 1) if sh.name in SHEET_NAMES for a, c in sorted(sh.cells.items(), key=lambda kv: (split_addr(kv[0])[1], col_num(split_addr(kv[0])[0]))) if c.kind == "f")
    parts["xl/calcChain.xml"] = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<calcChain xmlns="{NS_MAIN}">{chain}</calcChain>'
    ct = [
        f'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        f'<Default Extension="xml" ContentType="application/xml"/>',
        f'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ]
    for i in range(1, n_sheets + 1):
        ct.append(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    ct += [
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
        '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>',
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ]
    parts["[Content_Types].xml"] = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="{NS_CT}">{"".join(ct)}</Types>'
    titles = "".join(f"<vt:lpstr>{escape(s.name)}</vt:lpstr>" for s in sheets_all)
    parts["docProps/app.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Macintosh Excel</Application><DocSecurity>0</DocSecurity>'
        f'<ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>{n_sheets}</vt:i4></vt:variant></vt:vector></HeadingPairs>'
        f'<TitlesOfParts><vt:vector size="{n_sheets}" baseType="lpstr">{titles}</vt:vector></TitlesOfParts><AppVersion>16.0300</AppVersion></Properties>'
    )
    parts["docProps/core.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:creator>CoCheck test fixture</dc:creator><cp:lastModifiedBy>CoCheck test fixture</cp:lastModifiedBy>'
        f'<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-01T09:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{modified}</dcterms:modified></cp:coreProperties>'
    )
    if prefixed:
        parts = prefix_parts(parts, dup_sheet_id)
    return zip_bytes(parts)


def mix_rows(sh: Sheet, strings: Strings, bare_from_row: set[int]) -> str:
    """Scenario log after the agent appended rows: rows not in `bare_from_row` come from an Excel save (spans, shared strings),
    the appended rows are bare inline-string rows."""
    rows: dict[int, list[tuple[int, str, Cell]]] = {}
    for a, c in sh.cells.items():
        col, r = split_addr(a)
        rows.setdefault(r, []).append((col_num(col), a, c))
    out = []
    for r in sorted(rows):
        bare = r in bare_from_row
        cells = []
        for _, a, c in sorted(rows[r]):
            if c.kind == "s":
                cells.append(f'<c r="{a}" t="inlineStr"><is><t>{escape(c.value)}</t></is></c>' if bare else f'<c r="{a}" t="s"><v>{strings.id(c.value)}</v></c>')
            else:
                cells.append(f'<c r="{a}"><v>{num(c.value)}</v></c>')
        out.append(f'<row r="{r}">{"".join(cells)}</row>' if bare else f'<row r="{r}" spans="1:4">{"".join(cells)}</row>')
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="{NS_MAIN}" xmlns:r="{NS_REL}"><dimension ref="A1:D{max(rows)}"/>'
        f'<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>{"".join(out)}</sheetData></worksheet>'
    )


def prefix_parts(parts: dict[str, str], dup_sheet_id: bool) -> dict[str, str]:
    """Codex rewrote every XML part through ElementTree: namespace prefixes (ns0, s), single quotes in the declaration."""
    out = {}
    main_parts = ("xl/sharedStrings.xml", "xl/styles.xml", "xl/calcChain.xml")
    for name, text in parts.items():
        ET._namespace_map.clear()
        ET.register_namespace("r", NS_REL)
        root = ET.fromstring(text.encode("utf-8"))
        if name == "xl/workbook.xml":
            ET.register_namespace("s", NS_MAIN)
            body = ET.tostring(root, encoding="unicode")
        elif name.startswith("xl/worksheets/") or name in main_parts:
            ET.register_namespace("", NS_MAIN)
            body = ET.tostring(root, encoding="unicode")
        else:
            body = ET.tostring(root, encoding="unicode")
        out[name] = "<?xml version='1.0' encoding='utf-8'?>\n" + body
    return out


def zip_bytes(parts: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    order = ["[Content_Types].xml", "_rels/.rels"] + [n for n in parts if n not in ("[Content_Types].xml", "_rels/.rels")]
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n in order:
            zi = zipfile.ZipInfo(n, FIXED_DATE)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, parts[n].encode("utf-8"))
    return buf.getvalue()


def applescript_number(v) -> str:
    """How Excel's AppleScript Value2 prints a number: whole and decimal numbers as 1234.0 / 0.045, large ones as 3.4124E+4."""
    if isinstance(v, int) or float(v).is_integer():
        f = float(v)
        if abs(f) >= 10000:
            mant = f"{f:.4e}".split("e")[0].rstrip("0").rstrip(".")
            return f"{mant}E+{int(math.floor(math.log10(abs(f))))}"
        return f"{f:.1f}"
    return repr(float(v))


def write_raw_value2(path: str) -> None:
    """test/fixtures/excel-raw-value2-used-range.txt: the shape of Excel's raw {sheet name, Value2 of the used range, number format}
    answer for the Inputs sheet (6 columns), with CoCheck's own labels. test/excel-parse.test.ts reads it."""
    def q(t: str) -> str:
        return '"' + t.replace('"', '""') + '"'
    rows = [
        ("Sandbox inputs: change the yellow cells; the Model sheet projects from them.", None, None),
        ("Company inputs", None, None),
        ("Enter the name of the company", "Acme Components ", None),
        ("Date of valuation", 43951, None),
        ("Capitalize R&D?", "Yes", "If yes, fill in the R&D calc sheet"),
        ("Capitalize leases?", "No", "If yes, fill in the Lease calc sheet"),
        ("Normalize earnings?", "No", "If yes, fill in the Normalizer sheet"),
        ("Country", "Ruritania", None),
        ("Operating income =", 4800.0, "! If negative, normalize earnings first."),
        ("Interest expense =", 310.0, None),
        ("Capital spending", 1250.0, None),
        ("Depreciation =", 640.0, None),
        ("Marginal tax rate", 0.25, "Previous year-end"),
        ("Current revenues =", 34124, 28541),
        ("Non-cash working capital =", 2411.0, None),
        ("Book value of debt =", 6150, 5980),
        ("Book value of equity =", 10864, 10775),
        ("", None, None),
        ("Cash =", 2200.0, 2105.0),
        ("Minority interests", 0.0, 0.0),
        ("", None, None),
        ("Market data", None, None),
        ("Is the stock traded?", "Yes", None),
        ("Current stock price =", 804.14, None),
        ("Shares outstanding =", 1250.5, None),
        ("Market value of debt =", 6150, None),
        ("", None, None),
        ("General market data", None, None),
        ("Long-term riskfree rate =", 0.045, None),
        ("Equity risk premium =", 0.055, "Reference only"),
        ("", None, None),
        ("Ratings", None, None),
        ("Use a synthetic rating?", "No", None),
        ("Current rating", "AAA", None),
        ("Cost of debt for the rating =", 0.0509, None),
        ("", None, None),
        ("Valuation inputs", None, None),
        ("Length of high growth period =", 10.0, None),
        ("Beta for the high growth period =", 1.1, None),
        ("Return on capital =", 0.2, None),
        ("Reinvestment rate =", 0.3, None),
        ("", None, None),
        ("Stable growth period", None, None),
        ("Growth rate during stable growth period =", 0.04, None),
        ("Beta to use in stable growth period =", 1.0, None),
        ("Debt ratio in stable growth period =", 0.2, None),
        ("Tax rate in stable growth period =", 0.25, None),
    ]
    out = []
    for label, b, c in rows:
        cells = [q(label)]
        for v in (b, c):
            cells.append(q("") if v is None else q(v) if isinstance(v, str) else applescript_number(v))
        cells += [q("")] * 3
        out.append("{" + ", ".join(cells) + "}")
    with open(path, "w") as f:
        f.write('{"Inputs", {' + ", ".join(out) + "}, missing value}")


def main() -> None:
    root = os.path.join(HERE)
    base = build_book()
    base_list = [base[n] for n in SHEET_NAMES]
    S0IN = {}
    S2IN = {**EDIT5, "B31": 850}

    def write(rel: str, data: bytes) -> None:
        path = os.path.join(root, rel)
        with open(path, "wb") as f:
            f.write(data)

    write_raw_value2(os.path.join(root, "excel-raw-value2-used-range.txt"))
    mod0 = "2026-10-04T20:36:26Z"
    # S0: Excel-saved base, nothing edited
    s0 = package(base_list, recalculated=True, inputs_calc=S0IN, inputs_written=S0IN, excel=True, agent_sheets={}, variant="s0", modified=mod0)
    for rel in ("probe/S0.xlsx", "casebook-rerun/claude-S0.xlsx", "casebook-rerun/codex-S0.xlsx"):
        write(rel, s0)

    def s1(leg: str, prefixed=False, dup=False) -> bytes:
        # the agent edited sheet2.xml and added Scenario log as inline strings; nothing recalculated, so cached values are S0's
        return package(base_list + [log_sheet(log_rows(leg))], recalculated=False, inputs_calc=S0IN, inputs_written=EDIT5, excel=True,
                       agent_sheets={"Scenario log": "inline"}, variant="s1", dup_sheet_id=dup, prefixed=prefixed, modified=mod0)

    def s2(leg: str, rows_extra="none") -> bytes:
        # a person typed B31 in Excel: everything recalculated, shared strings and calc chain rewritten
        return package(base_list + [log_sheet(log_rows(leg))], recalculated=True, inputs_calc=S2IN, inputs_written=S2IN, excel=True,
                       agent_sheets={"Scenario log": "shared"}, variant="s2", modified="2026-10-04T20:41:10Z")

    def s3(leg: str, mc, s4=False, modified="2026-10-04T20:47:52Z") -> bytes:
        rows = log_rows(leg, "rows7to11", mc, s4)
        log = log_sheet(rows)
        # rows 1-6 came from Excel's save; rows 7 onwards are the agent's bare inline rows
        bare = set(range(7, len(rows) + 1))
        return package(base_list + [log, sens_sheet(mc)], recalculated=True, inputs_calc=S2IN, inputs_written=S2IN, excel=True,
                       agent_sheets={"Scenario log": "mixed", "Sensitivity": "inline"}, variant="s3", log_inline_rows=bare, modified=modified)

    write("probe/S1.xlsx", s1("claude"))
    write("probe/S2.xlsx", s2("claude"))
    write("probe/S3.xlsx", s3("claude", (0.05, 0.017105, 0.082895)))
    write("probe/codex-S1.xlsx", s1("codex"))
    write("probe/codex-S2.xlsx", s2("codex"))
    write("probe/codex-S3.xlsx", s3("codex", (0.05005058809212741, 0.01718532520139973, 0.08289258100373245)))
    r2c = s3("claude", (0.05000465282607349, 0.017115152006864795, 0.0829028546927296))
    write("probe/rerun-claude-S3.xlsx", r2c)
    write("casebook-rerun/claude-S3.xlsx", r2c)
    write("probe/rerun-codex-S3.xlsx", s3("codex", (0.04999385414568596, 0.017081020982172082, 0.08286890415062892)))
    write("casebook-rerun/claude-S1.xlsx", s1("claude"))
    write("casebook-rerun/claude-S4.xlsx", s3("claude", (0.05000465282607349, 0.017115152006864795, 0.0829028546927296), s4=True, modified="2026-10-04T20:55:03Z"))
    # Codex's rewrite of S1 (duplicate sheetId, Excel refused it), the repaired S1b, and the Excel save by hand S2
    write("casebook-rerun/codex-S1.xlsx", s1("codex", prefixed=True, dup=True))
    write("casebook-rerun/codex-S1b.xlsx", s1("codex", prefixed=True, dup=False))
    write("casebook-rerun/codex-S2.xlsx", s2("codex"))


if __name__ == "__main__":
    main()
