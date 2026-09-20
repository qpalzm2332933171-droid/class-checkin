# -*- coding: utf-8 -*-
"""极简 xlsx 生成器：只依赖标准库 zipfile，不引入第三方包。

支持：多工作表、行内字符串、数字、粗表头、冻结首行、列宽。
"""
import io
import zipfile

_XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"

STYLE_NORMAL = 0
STYLE_HEAD = 1
STYLE_CENTER = 2


def esc(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def col_name(index):
    """0 -> A, 25 -> Z, 26 -> AA"""
    name = ""
    index = int(index)
    while True:
        name = chr(ord("A") + index % 26) + name
        index = index // 26 - 1
        if index < 0:
            break
    return name


def cell_xml(ref, value, style=STYLE_NORMAL):
    attr = ' s="%d"' % style if style else ""
    if value is None or value == "":
        return '<c r="%s"%s/>' % (ref, attr)
    if isinstance(value, bool):
        value = "是" if value else "否"
    if isinstance(value, (int, float)):
        return '<c r="%s"%s><v>%s</v></c>' % (ref, attr, ("%g" % value) if isinstance(value, float) else value)
    return '<c r="%s"%s t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, attr, esc(value))


def sheet_xml(rows, widths=None, freeze=True):
    parts = [_XML_HEAD,
             '<worksheet xmlns="%s" xmlns:r="%s">' % (NS_MAIN, NS_R),
             '<sheetViews><sheetView workbookViewId="0">']
    if freeze:
        parts.append('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')
    parts.append("</sheetView></sheetViews>")
    if widths:
        parts.append("<cols>")
        for i, w in enumerate(widths):
            parts.append('<col min="%d" max="%d" width="%s" customWidth="1"/>' % (i + 1, i + 1, w))
        parts.append("</cols>")
    parts.append("<sheetData>")
    for r, row in enumerate(rows, start=1):
        cells = []
        for c, value in enumerate(row):
            style = STYLE_HEAD if r == 1 else STYLE_NORMAL
            if isinstance(value, tuple) and len(value) == 2:
                value, style = value
            cells.append(cell_xml(col_name(c) + str(r), value, style))
        parts.append('<row r="%d">%s</row>' % (r, "".join(cells)))
    parts.append("</sheetData></worksheet>")
    return "".join(parts)


def _styles_xml():
    return (_XML_HEAD + '<styleSheet xmlns="%s">' % NS_MAIN +
            '<fonts count="3">'
            '<font><sz val="11"/><name val="\u5fae\u8f6f\u96c5\u9ed1"/></font>'
            '<font><b/><sz val="11"/><name val="\u5fae\u8f6f\u96c5\u9ed1"/></font>'
            '<font><sz val="11"/><color rgb="FF666666"/><name val="\u5fae\u8f6f\u96c5\u9ed1"/></font>'
            "</fonts>"
            '<fills count="3">'
            '<fill><patternFill patternType="none"/></fill>'
            '<fill><patternFill patternType="gray125"/></fill>'
            '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE9FF"/><bgColor indexed="64"/></patternFill></fill>'
            "</fills>"
            '<borders count="1"><border/></borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="3">'
            '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" '
            'applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'
            '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
            "</cellXfs>"
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            "</styleSheet>")


def build(sheets):
    """sheets: [(名字, rows, widths)] -> bytes"""
    buf = io.BytesIO()
    names = [s[0] for s in sheets]
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        ct = [_XML_HEAD, '<Types xmlns="%s">' % NS_CT,
              '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
              '<Default Extension="xml" ContentType="application/xml"/>',
              '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.'
              'spreadsheetml.sheet.main+xml"/>',
              '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.'
              'spreadsheetml.styles+xml"/>']
        for i in range(len(sheets)):
            ct.append('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.'
                      'openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % (i + 1))
        ct.append("</Types>")
        z.writestr("[Content_Types].xml", "".join(ct))
        z.writestr("_rels/.rels", _XML_HEAD +
                   '<Relationships xmlns="%s"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/'
                   'officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
                   % NS_PKG_REL)
        sheets_xml = "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (esc(n)[:31], i + 1, i + 1)
                             for i, n in enumerate(names))
        z.writestr("xl/workbook.xml", _XML_HEAD +
                   '<workbook xmlns="%s" xmlns:r="%s"><sheets>%s</sheets></workbook>' % (NS_MAIN, NS_R, sheets_xml))
        rels = ['<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
                'worksheet" Target="worksheets/sheet%d.xml"/>' % (i + 1, i + 1) for i in range(len(sheets))]
        rels.append('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                    'relationships/styles" Target="styles.xml"/>' % (len(sheets) + 1))
        z.writestr("xl/_rels/workbook.xml.rels", _XML_HEAD +
                   '<Relationships xmlns="%s">%s</Relationships>' % (NS_PKG_REL, "".join(rels)))
        z.writestr("xl/styles.xml", _styles_xml())
        for i, item in enumerate(sheets):
            name, rows = item[0], item[1]
            widths = item[2] if len(item) > 2 else None
            z.writestr("xl/worksheets/sheet%d.xml" % (i + 1), sheet_xml(rows, widths))
    return buf.getvalue()


def save(path, sheets):
    with open(path, "wb") as fh:
        fh.write(build(sheets))
    return path
