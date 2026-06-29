from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NUMBERED_HEADING_PATTERN = re.compile(
    r"^\s*(?P<num>\d+(?:\.\d+)*)(?P<trailing>\.)?\s+(?P<rest>\S.*)$"
)
TABLE_TITLE_MAX_CHARS = 180


@dataclass
class SectionLike:
    title: str | None = None
    level: int | None = None


def _w(tag: str) -> str:
    return f"{{{WORD_NS}}}{tag}"


def clean_spaces(text: str) -> str:
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s+", "\n", text)
    return text.strip()


def _load_style_names(archive: zipfile.ZipFile) -> dict[str, str]:
    try:
        styles_xml = archive.read("word/styles.xml")
    except KeyError:
        return {}

    try:
        root = ET.fromstring(styles_xml)
    except ET.ParseError:
        return {}

    style_names: dict[str, str] = {}
    for style in root.findall(_w("style")):
        if style.attrib.get(_w("type")) != "paragraph":
            continue
        style_id = style.attrib.get(_w("styleId"))
        if not style_id:
            continue
        name_node = style.find(_w("name"))
        style_name = name_node.attrib.get(_w("val")) if name_node is not None else None
        style_names[style_id] = style_name or style_id
    return style_names


def _paragraph_style_name(paragraph: ET.Element, style_names: dict[str, str]) -> str | None:
    ppr = paragraph.find(_w("pPr"))
    if ppr is None:
        return None
    pstyle = ppr.find(_w("pStyle"))
    if pstyle is None:
        return None
    style_id = pstyle.attrib.get(_w("val"))
    if not style_id:
        return None
    return style_names.get(style_id, style_id)


def _heading_level_from_style(style_name: str | None) -> int | None:
    if not style_name:
        return None

    normalized = re.sub(r"[\s_\-]+", "", style_name.casefold())
    match = re.search(r"(?:heading|\u0437\u0430\u0433\u043e\u043b\u043e\u0432\u043e\u043a)([123])", normalized)
    if not match:
        return None
    return int(match.group(1))


def _heading_level_from_numbering(text: str) -> int | None:
    match = NUMBERED_HEADING_PATTERN.match(text)
    if not match:
        return None

    number = match.group("num")
    trailing_dot = bool(match.group("trailing"))
    level = len(number.split("."))

    if level == 1 and not trailing_dot:
        return None
    return min(level, 3)


def _heading_level(text: str, style_name: str | None = None) -> int | None:
    return _heading_level_from_style(style_name) or _heading_level_from_numbering(text)


def _paragraph_text(paragraph: ET.Element) -> str:
    parts: list[str] = []
    for node in paragraph.iter():
        if node.tag == _w("t"):
            parts.append(node.text or "")
        elif node.tag == _w("tab"):
            parts.append("\t")
        elif node.tag == _w("br"):
            parts.append("\n")
    return clean_spaces("".join(parts))


def _paragraph_has_page_break(paragraph: ET.Element) -> bool:
    for node in paragraph.iter():
        if node.tag == _w("lastRenderedPageBreak"):
            return True
        if node.tag == _w("br") and node.attrib.get(_w("type")) == "page":
            return True
    return False


def _cell_text(cell: ET.Element) -> str:
    paragraphs = [_paragraph_text(p) for p in cell.iter(_w("p"))]
    return clean_spaces(" ".join(p for p in paragraphs if p))


def _table_rows(table: ET.Element) -> list[list[str]]:
    rows: list[list[str]] = []
    for row in table.iter(_w("tr")):
        cells = [_cell_text(cell) for cell in row.findall(_w("tc"))]
        if any(cells):
            rows.append(cells)
    return rows


def _markdown_cell(text: str) -> str:
    return clean_spaces(text).replace("|", r"\|") or " "


def _markdown_table(rows: list[list[str]], title: str, section_title: str | None) -> str:
    column_count = max((len(row) for row in rows), default=0)
    if column_count == 0:
        return ""

    padded_rows = [row + [""] * (column_count - len(row)) for row in rows]
    header = [_markdown_cell(cell) for cell in padded_rows[0]]

    lines: list[str] = []
    if section_title:
        lines.append(f"[Section: {section_title}]")
    lines.append(f"[Table: {title}]")
    lines.append("")
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join("---" for _ in header) + " |")

    for row in padded_rows[1:]:
        lines.append("| " + " | ".join(_markdown_cell(cell) for cell in row) + " |")
    return "\n".join(lines).strip()


def _explicit_table_number(title: str) -> str | None:
    match = re.search(r"\b(?:\u0442\u0430\u0431\u043b\u0438\u0446[\u0430-\u044f]*|\u0442\u0430\u0431\u043b\.?|table)\s*(\d+(?:[.\-]\d+)*)", title, re.IGNORECASE)
    if match:
        return match.group(1).strip(".-")
    return None


def _is_table_title_candidate(text: str) -> bool:
    if not text or len(text) > TABLE_TITLE_MAX_CHARS:
        return False
    if _heading_level(text):
        return False

    lower = text.casefold()
    if re.search(r"\b\u0441\u043c\.?\s*(\u0442\u0430\u0431\u043b|\u0442\u0430\u0431\u043b\u0438\u0446|table)", lower):
        return False
    starts_with_table = re.match(r"\s*(\u0442\u0430\u0431\u043b\u0438\u0446[\u0430-\u044f]*|\u0442\u0430\u0431\u043b\.?|table)\b", lower) is not None
    if text.endswith(".") and not starts_with_table:
        return False
    return True


def _fallback_table_title(section: SectionLike, table_number: int) -> str:
    if section.title:
        return f"{section.title} Table {table_number}"
    return f"Table {table_number}"


def _preview_text(text: str, limit: int = 240) -> str:
    cleaned = clean_spaces(text).replace("\n", " ")
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "..."


def extract_docx_blocks(docx_path: str | Path) -> list[dict[str, Any]]:
    path = Path(docx_path)
    with zipfile.ZipFile(path) as archive:
        xml_bytes = archive.read("word/document.xml")
        style_names = _load_style_names(archive)

    root = ET.fromstring(xml_bytes)
    body = root.find(_w("body"))
    if body is None:
        return []

    blocks: list[dict[str, Any]] = []
    page_number = 1
    table_count = 0
    current_section_title: str | None = None
    current_section_level: int | None = None

    for block in body:
        if block.tag == _w("p"):
            text = _paragraph_text(block)
            style_name = _paragraph_style_name(block, style_names)
            heading_level = _heading_level(text, style_name) if text else None

            if heading_level:
                current_section_title = text
                current_section_level = heading_level

            if text:
                blocks.append({
                    "id": len(blocks),
                    "type": "paragraph",
                    "role": "heading" if heading_level else "paragraph",
                    "page_number": page_number,
                    "text": text,
                    "preview": _preview_text(text),
                    "style_name": style_name,
                    "heading_level": heading_level,
                    "section_title": current_section_title,
                    "section_level": current_section_level,
                })

            if _paragraph_has_page_break(block):
                page_number += 1

        elif block.tag == _w("tbl"):
            rows = _table_rows(block)
            if not rows:
                continue

            table_count += 1
            previous_text = None
            for previous in reversed(blocks):
                if previous.get("type") == "paragraph":
                    previous_text = previous.get("text")
                    break

            table_title = (
                previous_text.rstrip(" :")
                if previous_text and _is_table_title_candidate(previous_text)
                else _fallback_table_title(SectionLike(current_section_title, current_section_level), table_count)
            )
            table_number = _explicit_table_number(table_title) or f"auto:{table_count}"
            markdown = _markdown_table(rows, table_title, current_section_title)

            blocks.append({
                "id": len(blocks),
                "type": "table",
                "role": "table",
                "page_number": page_number,
                "text": markdown,
                "preview": _preview_text(markdown),
                "rows": rows,
                "table_title": table_title,
                "table_number": table_number,
                "section_title": current_section_title,
                "section_level": current_section_level,
            })

    return blocks
