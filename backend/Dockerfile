FROM python:3.11-slim

# LibreOffice is intentionally not installed by default because it is a large
# download. Install it manually when PDF preview is needed; see README.md.

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --timeout=300 --retries=5 -r requirements.txt

COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
