"""Build docs/EPWP_Capturer_Registration_Form.pdf.

A one-page, printable form for District Office staff who need a user account
to capture paper EPWP applications, with the guidelines capturers must follow.

Run from the project root:  python tools/make_capturer_form.py
"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (Flowable, Image, KeepTogether, Paragraph, SimpleDocTemplate,
                                Spacer, Table, TableStyle)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "EPWP_Capturer_Registration_Form.pdf"
LOGO = ROOT / "assets" / "logo.png"
SITE = "boetav.github.io/ecdoh-epwp_applications/capture.html"

GREEN = colors.HexColor("#0a6b3d")
DARK = colors.HexColor("#06402b")
YELLOW = colors.HexColor("#ffd21f")
PALE = colors.HexColor("#f3f9f2")
LINE = colors.HexColor("#8fa697")
MUTED = colors.HexColor("#4d5f54")
INK = colors.HexColor("#14261c")

MARGIN = 13 * mm
WIDTH = A4[0] - 2 * MARGIN

base = dict(fontName="Helvetica", textColor=INK, alignment=TA_LEFT)
S = {
    "title": ParagraphStyle("title", **dict(base, fontName="Helvetica-Bold", fontSize=15, leading=18, textColor=DARK)),
    "sub": ParagraphStyle("sub", **dict(base, fontSize=8.6, leading=11, textColor=MUTED)),
    "label": ParagraphStyle("label", **dict(base, fontSize=6.8, leading=8, textColor=MUTED)),
    "body": ParagraphStyle("body", **dict(base, fontSize=8.2, leading=10.4)),
    "small": ParagraphStyle("small", **dict(base, fontSize=7.4, leading=9.2)),
    "tick": ParagraphStyle("tick", **dict(base, fontSize=8, leading=9.6)),
    "guide": ParagraphStyle("guide", **dict(base, fontSize=8, leading=9.9)),
    "guidehead": ParagraphStyle("guidehead", **dict(base, fontName="Helvetica-Bold", fontSize=8.3, leading=10.4, textColor=DARK, spaceBefore=3, spaceAfter=1)),
    "foot": ParagraphStyle("foot", **dict(base, fontSize=6.8, leading=8.5, textColor=MUTED)),
}


class SectionBar(Flowable):
    """Green bar with a yellow letter disc, like the website's section headings."""

    def __init__(self, letter, text, note=""):
        super().__init__()
        self.letter, self.text, self.note = letter, text, note
        self.height = 15

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        return availWidth, self.height

    def draw(self):
        c = self.canv
        c.setFillColor(GREEN)
        c.roundRect(0, 0, self.width, self.height, 3, stroke=0, fill=1)
        c.setFillColor(YELLOW)
        c.circle(9, self.height / 2, 5.6, stroke=0, fill=1)
        c.setFillColor(DARK)
        c.setFont("Helvetica-Bold", 7.6)
        c.drawCentredString(9, self.height / 2 - 2.7, self.letter)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 8.6)
        c.drawString(20, self.height / 2 - 3, self.text.upper())
        if self.note:
            c.setFont("Helvetica", 7.2)
            c.drawRightString(self.width - 6, self.height / 2 - 2.6, self.note)


class Tick(Flowable):
    """An empty tick box followed by a label."""

    def __init__(self, text, width):
        super().__init__()
        self.para = Paragraph(text, S["tick"])
        self.box = 8
        self.width = width

    def wrap(self, availWidth, availHeight):
        _, h = self.para.wrap(self.width - self.box - 5, availHeight)
        self.height = max(h, self.box + 1)
        return self.width, self.height

    def draw(self):
        c = self.canv
        c.setStrokeColor(INK)
        c.setLineWidth(0.8)
        c.rect(0, self.height - self.box - 0.5, self.box, self.box, stroke=1, fill=0)
        self.para.drawOn(c, self.box + 5, 0)


def boxes(rows, widths, height=24):
    """A grid of labelled writing boxes. rows: list of lists of labels ('' = merged)."""
    data, spans = [], []
    for r, row in enumerate(rows):
        cells = []
        for c, label in enumerate(row):
            if label is None:
                cells.append("")
                continue
            cells.append(Paragraph(label, S["label"]))
        data.append(cells)
        # merge None cells into the cell on their left
        c = 0
        while c < len(row):
            end = c
            while end + 1 < len(row) and row[end + 1] is None:
                end += 1
            if end > c:
                spans.append(("SPAN", (c, r), (end, r)))
            c = end + 1
    t = Table(data, colWidths=[WIDTH * w for w in widths], rowHeights=[height] * len(rows))
    t.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.6, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
    ] + spans))
    return t


def ticks(labels, columns):
    col_w = WIDTH / columns
    flow = [Tick(text, col_w - 4) for text in labels]
    rows = [flow[i:i + columns] for i in range(0, len(flow), columns)]
    rows[-1] += [""] * (columns - len(rows[-1]))
    t = Table(rows, colWidths=[col_w] * columns)
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 2.2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2),
    ]))
    return t


def header():
    logo = Image(str(LOGO), width=46 * mm, height=46 * mm * 107 / 409)
    title = [
        Paragraph("EPWP Applications: Capturer Registration Form", S["title"]),
        Paragraph("<b>1.</b> Request your account online at <b>" + SITE + "</b> and choose your own username and "
                  "password. <b>2.</b> Complete, sign and have this form approved, then hand it to your EPWP District "
                  "Coordinator. Your account is activated only once this signed form is received.", S["sub"]),
    ]
    t = Table([[logo, title]], colWidths=[50 * mm, WIDTH - 50 * mm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("LINEBELOW", (0, 0), (-1, 0), 2.2, GREEN),
    ]))
    return t


GUIDELINES = [
    ("Capture only what you received", [
        "Capture only paper applications handed in at your own office, for applicants who live in your district. "
        "The system will not let you capture for another district.",
        "Type the details exactly as written on the paper form. Do not guess or \"correct\" an applicant's answers; "
        "if a form is unreadable or incomplete, set it aside and refer it to your coordinator.",
        "Enter the date the form was <b>received</b> (the date stamp), not the date you capture it.",
    ]),
    ("Check before you save", [
        "Check the ID number twice. The system fills in the date of birth and gender from it and refuses applicants "
        "younger than 18 or older than 45.",
        "Tick \"applicant signed\" only if the declaration and POPIA consent on the paper form are actually signed.",
        "Tick only the documents that are physically attached to the form.",
        "If the system says the ID number is already on the system, <b>do not capture it again</b>. Note the "
        "reference number shown on the paper form instead.",
    ]),
    ("After saving", [
        "Write the reference number the system gives you on the top of the paper form, and file the forms "
        "by reference number in a locked cabinet.",
        "You cannot change an application after saving. Report mistakes to the EPWP administrator with the "
        "reference number and the correct details.",
        "Capture forms on the day they are received where possible, and keep a daily count of forms received and captured.",
    ]),
    ("Your account", [
        "Your name is recorded on every application you capture. Never share your username or password, "
        "and never let anyone capture under your account.",
        "Sign out when you leave the computer. Sign-in ends by itself after 6 hours or when the browser tab is closed.",
        "You chose your own password when you requested the account. Five wrong passwords lock the account for "
        "15 minutes. For a new password, contact the EPWP administrator.",
    ]),
    ("Confidentiality (POPIA)", [
        "Applicants' personal information is confidential. Do not photograph, copy, print, send or discuss it "
        "except for capturing and official EPWP work.",
        "Use only the official sign-in page: <b>" + SITE + "</b>",
    ]),
    ("Integrity", [
        "Applying and capturing are free. Never ask for or accept money, gifts or favours from applicants, and "
        "report anyone who does to your District Office manager.",
        "Treat every applicant the same way. Capturing an application does not mean the applicant has been selected; "
        "all shortlisting is done by Head Office.",
    ]),
]


def guidelines():
    numbered, n = [], 0
    for head, items in GUIDELINES:
        block = [Paragraph(head, S["guidehead"])]
        for item in items:
            n += 1
            block.append(Table([[Paragraph("<b>%d.</b>" % n, S["guide"]), Paragraph(item, S["guide"])]],
                               colWidths=[15, WIDTH / 2 - 26],
                               style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                                 ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                                 ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                                                 ("TOPPADDING", (0, 0), (-1, -1), 0.6),
                                                 ("BOTTOMPADDING", (0, 0), (-1, -1), 0.6)])))
        numbered.append(block)
    left = numbered[:3]
    right = numbered[3:]
    flat = lambda groups: [f for g in groups for f in g]
    t = Table([[flat(left), flat(right)]], colWidths=[WIDTH / 2, WIDTH / 2])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("BACKGROUND", (0, 0), (-1, -1), PALE),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("LINEAFTER", (0, 0), (0, 0), 0.6, LINE),
    ]))
    return t


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(YELLOW)
    canvas.rect(0, 0, A4[0] * 0.38, 5, stroke=0, fill=1)
    canvas.setFillColor(GREEN)
    canvas.rect(A4[0] * 0.38, 0, A4[0] * 0.62, 5, stroke=0, fill=1)
    canvas.setFont("Helvetica", 6.6)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, 9, "Eastern Cape Department of Health  ·  Expanded Public Works Programme (EPWP)  ·  "
                                 "Keep the completed form on file with the EPWP administrator.")
    canvas.drawRightString(A4[0] - MARGIN, 9, "Version 2, November 2026")
    canvas.restoreState()


def build():
    story = [header(), Spacer(1, 6)]

    story += [SectionBar("A", "Capturer details"), Spacer(1, 2), boxes([
        ["Title", "First name(s)", None, "Surname", None],
        ["Persal / employee number", None, "Job title / rank", "Work telephone", "Cellphone"],
        ["Office or facility where you work (name and address)", None, None, "Email address", None],
    ], [0.12, 0.22, 0.2, 0.23, 0.23], height=27), Spacer(1, 6)]

    story += [SectionBar("B", "Access requested", "Tick ONE box"), Spacer(1, 1),
              Paragraph("A district capturer can only capture and see applicants who live in that district. "
                        "Provincial access (all districts) is for Head Office officials only.", S["small"]),
              ticks(["Alfred Nzo District", "Amathole District", "Buffalo City Metro",
                     "Chris Hani District", "Joe Gqabi District", "Nelson Mandela Bay Metro",
                     "OR Tambo District", "Sarah Baartman District",
                     "<b>Provincial (all districts)</b> - Head Office only"], 3),
              Spacer(1, 5)]

    story += [SectionBar("C", "Declaration by the capturer"), Spacer(1, 2),
              Paragraph("I have read the guidelines on this form and will follow them. I will keep my password secret, "
                        "capture applications exactly as received, and keep applicants' personal information "
                        "confidential in line with the Protection of Personal Information Act (POPIA). I understand "
                        "that every application I capture is recorded under my name and that misuse of the system "
                        "may lead to disciplinary action.", S["body"]),
              Spacer(1, 3),
              boxes([["Signature of capturer", None, "Date", "Username you requested online, e.g. nomsa.dlamini"]],
                    [0.3, 0.12, 0.18, 0.4], height=28), Spacer(1, 6)]

    story += [SectionBar("D", "Approval by supervisor / EPWP District Coordinator"), Spacer(1, 2),
              boxes([["Full name", "Designation", "Signature", "Date"]], [0.3, 0.27, 0.25, 0.18], height=28),
              Spacer(1, 6)]

    story += [SectionBar("E", "For the EPWP system administrator only"), Spacer(1, 2),
              boxes([["Online request found (username)", "Access approved", "Approved in system by",
                      "Date approved", "Signature"]],
                    [0.24, 0.2, 0.22, 0.14, 0.2], height=27),
              Spacer(1, 7)]

    story += [KeepTogether([SectionBar("!", "Guidelines: what is expected from you as a capturer"),
                            Spacer(1, 2), guidelines()])]

    doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                            topMargin=11 * mm, bottomMargin=11 * mm,
                            title="EPWP Capturer Registration Form",
                            author="Eastern Cape Department of Health",
                            subject="Request for a user account to capture EPWP paper applications")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print("wrote", OUT)


if __name__ == "__main__":
    build()
