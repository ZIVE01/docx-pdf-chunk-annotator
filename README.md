# DOCX/PDF Chunk Annotator

A web-based manual chunk annotation tool for RAG pipelines.

Open DOCX files, create semantic chunks, preview the converted PDF, draw and resize chunk highlight regions, then export JSON+PDF or save the annotation on the backend.

## AI Disclosure

This project was developed with assistance from AI coding tools. The code should be reviewed, tested, and validated before use with production or sensitive documents.

## Features

- Open `.docx` files in a browser.
- Extract DOCX blocks as paragraphs, headings, and tables.
- Create manual chunks from selected blocks.
- Mark chunks as `text`, `table`, or `equation`.
- Add section and table context.
- Convert DOCX to PDF with LibreOffice.
- Draw, move, and resize PDF highlight regions.
- Store several PDF regions for one chunk, including multi-page tables.
- Export manual annotation as JSON plus PDF.
- Save annotation files on the backend under `data/exports/`.

## Requirements

- Docker Desktop with Docker Compose v2
- Modern browser: Chrome, Edge, or Firefox
- LibreOffice Writer inside the backend container for DOCX to PDF preview

The app works without a database. It is a standalone annotation utility. Integration with PostgreSQL, FAISS, or a RAG backend can be added separately.

## Quick Start

```powershell
docker compose up -d --build
```

Open:

```text
http://localhost:5173
```

## Large Dependency Note

LibreOffice Writer is required for DOCX to PDF preview, but it is intentionally not installed automatically in `backend/Dockerfile` because it is a large download.

Install it manually after the containers start:

```powershell
docker compose exec -T backend sh -lc "DEBIAN_FRONTEND=noninteractive apt-get update -o Acquire::Retries=5 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libreoffice-writer fonts-dejavu fonts-liberation && rm -rf /var/lib/apt/lists/*"
```

Then restart the backend:

```powershell
docker compose restart backend
```

## Workflow

1. Click `Open DOCX`.
2. Select text/table blocks in the DOCX view.
3. Choose chunk type.
4. Add a section title if needed.
5. Click `Create Chunk`.
6. Open the `PDF` tab.
7. Adjust the PDF highlight area.
8. Use `JSON+PDF` to download files.
9. Use `Save` to store annotation files on the backend.

## Export Format

The exported JSON includes:

```json
{
  "filename": "example.docx",
  "preview_id": "temporary-preview-id",
  "pdf_preview": "/docx-preview/<preview_id>/pdf",
  "pdf_file": "example-preview.pdf",
  "chunks": [
    {
      "chunk_index": 0,
      "chunk_type": "text",
      "section_title": "General requirements",
      "table_title": "",
      "page_number": 1,
      "text": "Chunk text",
      "block_ids": [1, 2, 3],
      "bbox": {
        "unit": "pdf_points",
        "regions": [
          {
            "id": "region-1",
            "page": 1,
            "x1": 100,
            "y1": 120,
            "x2": 400,
            "y2": 240,
            "unit": "pdf_points"
          }
        ]
      }
    }
  ]
}
```

## API

- `POST /api/docx-preview`
- `GET /api/docx-preview/{preview_id}/pdf`
- `POST /api/docx-preview/{preview_id}/save`

## Development Commands

Backend syntax check:

```powershell
docker compose exec -T backend python -m py_compile main.py app/docx_blocks.py
```

Frontend build:

```powershell
docker compose exec -T frontend npm run build
```
