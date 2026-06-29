from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.docx_blocks import extract_docx_blocks

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
PREVIEW_ROOT = DATA_DIR / "previews"
EXPORT_ROOT = DATA_DIR / "exports"

app = FastAPI(title="DOCX/PDF Chunk Annotator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChunkIn(BaseModel):
    chunk_index: int
    chunk_type: str = "text"
    section_title: str | None = None
    table_title: str | None = None
    table_number: str | None = None
    page_number: int | None = None
    text: str
    bbox: dict | None = None
    block_ids: list[int] = Field(default_factory=list)


class SaveAnnotationIn(BaseModel):
    filename: str | None = None
    chunks: list[ChunkIn]


def _safe_filename(filename: str | None) -> str:
    return Path((filename or "document.docx").replace("\\", "/")).name


def _safe_stem(filename: str | None) -> str:
    stem = Path(_safe_filename(filename)).stem or "document"
    return "".join(char if char.isalnum() or char in "-_." else "_" for char in stem)[:120] or "document"


def _preview_dir(preview_id: str) -> Path:
    normalized = (preview_id or "").strip().lower()
    if not normalized or any(char not in "0123456789abcdef" for char in normalized):
        raise HTTPException(status_code=404, detail="Preview not found")
    path = PREVIEW_ROOT / normalized
    if not path.exists():
        raise HTTPException(status_code=404, detail="Preview not found")
    return path


def _libreoffice_binary() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")


def _convert_docx_to_pdf(source_path: Path) -> Path:
    office = _libreoffice_binary()
    if not office:
        raise HTTPException(
            status_code=501,
            detail="DOCX to PDF preview is unavailable: LibreOffice is not installed",
        )

    target_path = source_path.parent / "preview.pdf"
    if target_path.exists() and target_path.stat().st_mtime >= source_path.stat().st_mtime:
        return target_path

    with tempfile.TemporaryDirectory(prefix="docx_pdf_", dir=str(source_path.parent)) as tmp_dir:
        profile_dir = Path(tmp_dir) / "lo_profile"
        command = [
            office,
            f"-env:UserInstallation=file://{profile_dir.as_posix()}",
            "--headless",
            "--nologo",
            "--nofirststartwizard",
            "--convert-to",
            "pdf",
            "--outdir",
            tmp_dir,
            str(source_path),
        ]
        try:
            result = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(status_code=504, detail="DOCX to PDF conversion timed out") from exc

        produced_path = Path(tmp_dir) / f"{source_path.stem}.pdf"
        if result.returncode != 0 or not produced_path.exists():
            error = (result.stderr or result.stdout or "LibreOffice did not return a PDF").strip()
            raise HTTPException(status_code=500, detail=f"DOCX to PDF conversion failed: {error[:500]}")

        if target_path.exists():
            target_path.unlink()
        shutil.move(str(produced_path), target_path)

    return target_path


def _preview_pdf_path(preview_id: str) -> Path:
    preview_dir = _preview_dir(preview_id)
    source_path = preview_dir / "original.docx"
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Original DOCX not found")
    return _convert_docx_to_pdf(source_path)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/docx-preview")
def create_docx_preview(file: UploadFile = File(...)):
    safe_filename = _safe_filename(file.filename)
    if Path(safe_filename).suffix.lower() != ".docx":
        raise HTTPException(status_code=400, detail="Only DOCX files are supported")

    PREVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    preview_id = uuid4().hex
    preview_dir = PREVIEW_ROOT / preview_id
    preview_dir.mkdir(parents=True, exist_ok=True)
    source_path = preview_dir / "original.docx"

    try:
        with source_path.open("wb") as saved:
            shutil.copyfileobj(file.file, saved)

        blocks = extract_docx_blocks(source_path)

        pdf_ready = False
        pdf_error = None
        try:
            _convert_docx_to_pdf(source_path)
            pdf_ready = True
        except HTTPException as exc:
            pdf_error = exc.detail

        return {
            "filename": safe_filename,
            "preview_id": preview_id,
            "pdf_ready": pdf_ready,
            "pdf_url": f"/docx-preview/{preview_id}/pdf" if pdf_ready else None,
            "pdf_error": pdf_error,
            "block_count": len(blocks),
            "paragraph_count": sum(1 for block in blocks if block.get("type") == "paragraph"),
            "table_count": sum(1 for block in blocks if block.get("type") == "table"),
            "blocks": blocks,
        }
    except (KeyError, zipfile.BadZipFile) as exc:
        shutil.rmtree(preview_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Invalid DOCX file") from exc


@app.get("/api/docx-preview/{preview_id}/pdf")
def get_docx_preview_pdf(preview_id: str):
    pdf_path = _preview_pdf_path(preview_id)
    return FileResponse(
        str(pdf_path),
        media_type="application/pdf",
        filename=f"docx_preview_{preview_id}.pdf",
    )


@app.post("/api/docx-preview/{preview_id}/save")
def save_annotation(preview_id: str, payload: SaveAnnotationIn):
    preview_dir = _preview_dir(preview_id)
    source_path = preview_dir / "original.docx"
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Original DOCX not found")

    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    export_dir = EXPORT_ROOT / f"{timestamp}_{_safe_stem(payload.filename)}"
    export_dir.mkdir(parents=True, exist_ok=True)

    json_payload = {
        "filename": payload.filename,
        "preview_id": preview_id,
        "pdf_file": "preview.pdf",
        "chunks": [chunk.model_dump() for chunk in payload.chunks],
    }
    (export_dir / "manual-chunks.json").write_text(
        json.dumps(json_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    shutil.copy2(source_path, export_dir / "original.docx")
    pdf_saved = False
    try:
        pdf_path = _preview_pdf_path(preview_id)
        shutil.copy2(pdf_path, export_dir / "preview.pdf")
        pdf_saved = True
    except HTTPException:
        pdf_saved = False

    return {
        "saved": True,
        "export_dir": str(export_dir),
        "chunks_saved": len(payload.chunks),
        "pdf_saved": pdf_saved,
    }

