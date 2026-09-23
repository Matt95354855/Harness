"""Local discovery server using synthetic examples and SQLite.

This is deliberately distinct from the production PostgreSQL/ML pipeline.
Bind to loopback only: the demo has no authentication and stores user uploads locally.
"""
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
import csv
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import unicodedata
import uuid

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from .__init__ import __version__

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("MASS_DEMO_DATA_DIR", ".mass-demo")).resolve()
DB_FILE = DATA_DIR / "demo.sqlite3"
MAX_BYTES = 5 * 1024 * 1024
ALLOWED = {".txt", ".md", ".csv", ".tsv", ".json", ".eml"}

SAMPLES = [
    ("01-releve-synthetique.txt", "Relevé fictif — dossier Atlas", """Relevé bancaire fictif, dossier Atlas, avril 2026.
Le 14 avril, un virement de 1 250 EUR a été inscrit du compte Atlas vers le compte Nova.
Le 16 avril, un virement de 980 EUR a été inscrit du compte Atlas vers le compte Nova.
Le 18 avril, un virement de 1 100 EUR a été inscrit du compte Atlas vers le compte Delta.
Ces lignes servent uniquement à démontrer la recherche de montants et de références dans des pièces. Aucun paiement réel ni anomalie validée.
"""),
    ("02-courriel-synthetique.txt", "Courriel fictif — pièces demandées", """Courriel fictif du 20 avril 2026.
Alice Martin travaille chez Banque Atlas. Alice Martin demande à Nova Services une facture liée au virement de 1 250 EUR du 14 avril.
Nova Services confirme avoir reçu le message et promet de transmettre le justificatif.
La relation professionnelle citée ici provient exclusivement de ce texte synthétique et doit être vérifiée dans un dossier réel.
"""),
    ("03-note-enquete-synthetique.txt", "Note fictive — chronologie", """Note de synthèse fictive du dossier Atlas.
L'enquête rassemble le relevé, le courriel d'Alice Martin et les justificatifs transmis par Nova Services.
Une revue humaine doit rapprocher les dates et vérifier les sources avant toute conclusion.
Cette note d'exemple ne décrit aucune personne, entreprise ou transaction réelle.
"""),
]


@contextmanager
def database():
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalized(text: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFKD", text.casefold())
                   if not unicodedata.combining(char))


def tokens(text: str) -> set[str]:
    ignored = {"dans", "pour", "avec", "quel", "quelle", "quels", "elles", "nous", "vous", "les", "des", "une", "est", "sur", "the", "and", "what"}
    return {term for term in re.findall(r"[a-z0-9]{3,}", normalized(text)) if term not in ignored}


def analyze(text: str) -> dict:
    lower = normalized(text)
    terms = {"finance": ["virement", "compte", "bancaire", "facture"],
             "enquete": ["enquete", "dossier", "justificatif", "preuve"]}
    matched = {label: [term for term in words if term in lower] for label, words in terms.items()}
    money = re.findall(r"\b\d[\d .,]*\s?(?:EUR|USD|GBP|€)\b", text, flags=re.I)
    labels = {key: round(min(.95, .25 + len(values) * .18), 2) for key, values in matched.items() if values}
    priority = min(100, 8 * len(money) + 4 * len(labels))
    return {
        "labels": {"domain_scores": labels, "review_priority": priority, "method": "demo:rules:v1"},
        "signals": {"word_count": len(text.split()), "money_mentions": len(money), "amounts": money[:12]},
        "topology": {"status": "unavailable", "reason": "demo_mode"},
        "predictions": {"status": "unavailable", "reason": "no_approved_trained_model"},
        "explanation": {"matched_terms": {key: values for key, values in matched.items() if values},
                        "limitations": "Démonstration à règles simples sur données fictives. Aucune inférence de fraude ou de culpabilité."},
        "model_version": "demo:rules:v1",
    }


def create_document(conn, filename: str, content: str, source: dict) -> dict:
    sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
    previous = conn.execute("SELECT id,status FROM documents WHERE sha256=?", (sha,)).fetchone()
    if previous:
        return {"id": previous["id"], "status": previous["status"], "duplicate": True}
    doc_id = str(uuid.uuid4())
    created = now()
    conn.execute("INSERT INTO documents(id,filename,content,source,sha256,byte_size,status,created_at,analysis) VALUES (?,?,?,?,?,?,?,?,?)",
                 (doc_id, filename, content, json.dumps(source), sha, len(content.encode()), "ready", created, json.dumps(analyze(content))))
    conn.execute("INSERT INTO audit(action,subject,created_at) VALUES (?,?,?)", ("uploaded", doc_id, created))
    return {"id": doc_id, "status": "ready", "duplicate": False}


def initialize():
    DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    with database() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY, filename TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL,
                sha256 TEXT NOT NULL UNIQUE, byte_size INTEGER NOT NULL, status TEXT NOT NULL,
                created_at TEXT NOT NULL, analysis TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS feedback (
                id TEXT PRIMARY KEY, document_id TEXT NOT NULL, label TEXT NOT NULL,
                accepted INTEGER NOT NULL, comment TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, subject TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
        """)
        if not conn.execute("SELECT 1 FROM documents LIMIT 1").fetchone():
            for filename, title, content in SAMPLES:
                event_at = {"01-releve-synthetique.txt": "2026-04-14T00:00:00+00:00",
                            "02-courriel-synthetique.txt": "2026-04-20T00:00:00+00:00"}.get(filename)
                source = {"title": title, "type": "synthetic_example"}
                if event_at:
                    source["event_at"] = event_at
                create_document(conn, filename, content, source)


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize()
    yield


app = FastAPI(title="Mass Classification — découverte locale", version=__version__, lifespan=lifespan)


@app.middleware("http")
async def headers(request, call_next):
    response = await call_next(request)
    response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                             "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"})
    return response


@app.get("/")
def home():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/static/{filename}")
def asset(filename: str):
    if filename not in {"app.js", "style.css", "manifest.json", "sw.js", "icon.svg", "offline.html"}:
        raise HTTPException(404)
    return FileResponse(ROOT / "static" / filename)


@app.get("/health/live")
def live():
    return {"status": "ok"}


@app.get("/v1/session")
def session():
    return {"mode": "demo", "tenant": "Exemples locaux", "role": "admin",
            "notice": "Données fictives ; extraction textuelle et recherche lexicale."}


@app.get("/v1/documents")
def documents(limit: int = 50, offset: int = 0):
    if not 1 <= limit <= 100 or not 0 <= offset <= 100000:
        raise HTTPException(422, "Pagination invalide")
    with database() as conn:
        rows = conn.execute("SELECT id,filename,byte_size,source,status,created_at FROM documents "
                            "ORDER BY created_at DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        return [dict(row) | {"source": json.loads(row["source"])} for row in rows]


@app.get("/v1/timeline")
def timeline(limit: int = 100):
    from .temporal import timeline as build_timeline
    if not 1 <= limit <= 250:
        raise HTTPException(422, "Limite invalide")
    with database() as conn:
        rows = [dict(row) | {"source": json.loads(row["source"])} for row in
                conn.execute("SELECT id,filename,status,source,created_at FROM documents "
                             "ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()]
    return build_timeline(rows)


def get_document(conn, doc_id):
    row = conn.execute("SELECT * FROM documents WHERE id=?", (str(doc_id),)).fetchone()
    if row is None:
        raise HTTPException(404, "Document introuvable")
    return row


@app.get("/v1/documents/{doc_id}")
def document(doc_id: uuid.UUID):
    with database() as conn:
        row = get_document(conn, doc_id)
        conn.execute("INSERT INTO audit(action,subject,created_at) VALUES (?,?,?)", ("viewed", str(doc_id), now()))
        return {"id": row["id"], "filename": row["filename"], "status": "ready", "content": row["content"],
                "source": json.loads(row["source"]), "analysis": json.loads(row["analysis"]),
                "metadata": {"sha256": row["sha256"], "bytes": row["byte_size"]}, "language": "fr", "error": None}


@app.post("/v1/documents", status_code=202)
def upload(file: UploadFile = File(...), source_json: str = Form("{}")):
    filename = Path(file.filename or "document.txt").name[:200]
    if Path(filename).suffix.lower() not in ALLOWED:
        raise HTTPException(415, "Mode découverte : importer un fichier TXT, MD, CSV, TSV, JSON ou EML")
    blob = file.file.read(MAX_BYTES + 1)
    if len(blob) > MAX_BYTES:
        raise HTTPException(413, "Limite du mode découverte : 5 Mio")
    if not blob or b"\x00" in blob:
        raise HTTPException(422, "Fichier vide ou binaire")
    try:
        content = blob.decode("utf-8-sig")
        source = json.loads(source_json)
        if not isinstance(source, dict) or len(source_json) > 4096:
            raise ValueError()
        if filename.endswith(".json"):
            json.loads(content)
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(422, "Fichier UTF-8 ou métadonnées JSON invalides")
    with database() as conn:
        return create_document(conn, filename, content, source)


class Query(BaseModel):
    query: str = Field(min_length=2, max_length=1000)
    limit: int = Field(default=5, ge=1, le=20)


def find_passages(query: str, limit: int) -> list[dict]:
    query_terms = tokens(query)
    if not query_terms:
        return []
    with database() as conn:
        rows = conn.execute("SELECT id,filename,content FROM documents").fetchall()
        passages = []
        for row in rows:
            chunks = [part.strip() for part in re.split(r"\n\s*\n|(?<=[.!?])\s+(?=[A-ZÀ-Ÿ])", row["content"]) if part.strip()]
            for ordinal, part in enumerate(chunks):
                overlap = query_terms & tokens(part)
                if overlap:
                    score = round(len(overlap) / math.sqrt(len(query_terms) * max(1, len(tokens(part)))), 3)
                    passages.append({"document_id": row["id"], "filename": row["filename"], "ordinal": ordinal,
                                     "text": part[:900], "similarity": score})
        return sorted(passages, key=lambda item: (-item["similarity"], item["filename"]))[:limit]


@app.post("/v1/search")
def search(payload: Query):
    return find_passages(payload.query, payload.limit)


@app.post("/v1/ask")
def ask(payload: Query):
    matches = find_passages(payload.query, payload.limit)
    return {"question": payload.query,
            "answer": "\n\n".join(item["text"] for item in matches[:3]) if matches else "Aucun passage trouvé dans les exemples locaux.",
            "citations": [{"document_id": item["document_id"], "chunk": item["ordinal"], "similarity": item["similarity"]}
                          for item in matches[:3]], "method": "demo:lexical_retrieval"}


@app.get("/v1/graph")
def graph(limit: int = 150):
    if not 1 <= limit <= 500:
        raise HTTPException(422, "Limite invalide")
    pattern = re.compile(r"\b([A-ZÀ-Ÿ][\wÀ-ÿ-]+(?:\s+[A-ZÀ-Ÿ][\wÀ-ÿ-]+)?)\s+(travaille chez|works at)\s+([A-ZÀ-Ÿ][\wÀ-ÿ-]+(?:\s+[A-ZÀ-Ÿ][\wÀ-ÿ-]+)?)", re.I)
    with database() as conn:
        rows = conn.execute("SELECT id,content FROM documents").fetchall()
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    for row in rows:
        for match in pattern.finditer(row["content"]):
            src, dst = match.group(1), match.group(3)
            source_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, normalized(src)))
            target_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, normalized(dst)))
            nodes[source_id] = {"id": source_id, "canonical": src, "kind": "mention"}
            nodes[target_id] = {"id": target_id, "canonical": dst, "kind": "mention"}
            edges.append({"source_id": source_id, "target_id": target_id, "document_id": row["id"],
                          "kind": "travaille chez", "confidence": 0.75, "evidence": match.group(0)})
    return {"nodes": list(nodes.values()), "edges": edges[:limit]}


class Review(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    accepted: bool
    comment: str = Field(default="", max_length=2000)


@app.post("/v1/documents/{doc_id}/feedback", status_code=201)
def feedback(doc_id: uuid.UUID, review: Review):
    with database() as conn:
        get_document(conn, doc_id)
        item_id, stamp = str(uuid.uuid4()), now()
        conn.execute("INSERT INTO feedback(id,document_id,label,accepted,comment,created_at) VALUES (?,?,?,?,?,?)",
                     (item_id, str(doc_id), review.label, int(review.accepted), review.comment, stamp))
        conn.execute("INSERT INTO audit(action,subject,created_at) VALUES (?,?,?)", ("reviewed", str(doc_id), stamp))
        return {"id": item_id}


@app.get("/v1/audit")
def audit(limit: int = 100):
    if not 1 <= limit <= 500:
        raise HTTPException(422, "Limite invalide")
    with database() as conn:
        return [dict(row) | {"details": {"mode": "demo"}} for row in
                conn.execute("SELECT action,subject,created_at FROM audit ORDER BY id DESC LIMIT ?", (limit,)).fetchall()]


@app.get("/v1/monitoring")
def monitoring():
    with database() as conn:
        count = conn.execute("SELECT count(*) AS n FROM documents").fetchone()["n"]
    return {"status": [{"status": "ready", "total": count}], "pending_jobs": 0, "model_versions": [],
            "feedback_last_30_days": []}


@app.get("/v1/exports/documents.csv")
def export_csv():
    with database() as conn:
        rows = conn.execute("SELECT id,filename,status,created_at,sha256 FROM documents ORDER BY created_at DESC").fetchall()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id", "filename", "status", "created_at", "sha256"])
    for row in rows:
        writer.writerow([row[field] for field in ("id", "filename", "status", "created_at", "sha256")])
    return Response(output.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=documents.csv"})


@app.get("/v1/documents/{doc_id}/report.pdf")
def report(doc_id: uuid.UUID):
    from reportlab.pdfgen import canvas
    with database() as conn:
        row = get_document(conn, doc_id)
    stream = io.BytesIO()
    pdf = canvas.Canvas(stream)
    lines = ["Mass Classification - rapport de demonstration", f"Piece : {row['filename']}",
             f"ID : {row['id']}", f"SHA-256 : {row['sha256']}",
             "Donnees fictives ou importees localement. Verification humaine requise."]
    for index, line in enumerate(lines):
        pdf.drawString(45, 790 - index * 22, line.encode("ascii", errors="replace").decode())
    pdf.save(); stream.seek(0)
    return StreamingResponse(stream, media_type="application/pdf", headers={"Content-Disposition": f"attachment; filename={doc_id}.pdf"})


def main():
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser(description="Try the local Mass Classification discovery mode")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")
    print(f"Ouvrir http://127.0.0.1:{args.port} — mode découverte local, sans authentification", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
