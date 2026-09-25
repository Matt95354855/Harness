"""Tenant isolated REST API, evidence search and human review UI."""
from contextlib import asynccontextmanager
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import uuid

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from psycopg.types.json import Jsonb
import redis
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
import time

from .config import settings
from .db import migrate, transaction, audit, verify_audit, tenant_embedding


@asynccontextmanager
async def lifespan(app: FastAPI):
    migrate()
    settings().data_dir.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="Mass Classification", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings().allowed_origins, allow_methods=["GET", "POST"],
                   allow_headers=["Authorization", "Content-Type"], allow_credentials=False)
REQUESTS = Counter("mass_http_requests_total", "HTTP requests", ["method", "route", "status"])
LATENCY = Histogram("mass_http_request_seconds", "Request duration", ["method", "route"])


@app.middleware("http")
async def observe(request: Request, call_next):
    start = time.monotonic()
    response = await call_next(request)
    route = request.scope.get("route")
    label = route.path if route else "unmatched"
    REQUESTS.labels(request.method, label, str(response.status_code)).inc()
    LATENCY.labels(request.method, label).observe(time.monotonic() - start)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    response.headers["Cache-Control"] = "no-store"
    return response


class Principal(BaseModel):
    tenant: str
    role: str
    key_id: uuid.UUID


def principal(authorization: str | None = Header(default=None)) -> Principal:
    if not authorization or not authorization.startswith("Bearer mc_"):
        raise HTTPException(401, "Bearer API key required")
    digest = hashlib.sha256(authorization[7:].encode()).hexdigest()
    with transaction() as conn:
        row = conn.execute("SELECT id,tenant_id,role FROM api_keys WHERE key_hash=%s AND active=true "
                           "AND (expires_at IS NULL OR expires_at>now())", (digest,)).fetchone()
    if row is None:
        raise HTTPException(401, "Invalid API key")
    return Principal(tenant=row["tenant_id"], role=row["role"], key_id=row["id"])


def require(*roles):
    def check(user: Principal = Depends(principal)):
        if user.role not in roles:
            raise HTTPException(403, "Insufficient role")
        return user
    return check


def throttle(user: Principal, action: str, limit: int = 120):
    url = os.environ.get("REDIS_URL")
    if not url:
        raise HTTPException(503, "Rate limiter not configured")
    try:
        client = redis.Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1)
        key = f"limit:{user.key_id}:{action}"
        count = client.incr(key)
        if count == 1:
            client.expire(key, 60)
    except redis.RedisError as exc:
        raise HTTPException(503, "Rate limiter unavailable") from exc
    if count > limit:
        raise HTTPException(429, "Rate limit exceeded")


@app.get("/health/live")
def live():
    return {"status": "ok"}


@app.get("/health/ready")
def ready():
    with transaction() as conn:
        conn.execute("SELECT 1")
    return {"status": "ready"}


@app.get("/v1/session")
def session(user: Principal = Depends(principal)):
    """Let the console verify a key and display the active workspace."""
    return {"mode": "production", "tenant": user.tenant, "role": user.role}


@app.get("/metrics")
def metrics(user: Principal = Depends(require("admin"))):
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/")
def home():
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.get("/static/{filename}")
def asset(filename: str):
    if filename not in {"app.js", "style.css", "manifest.json", "sw.js", "icon.svg", "offline.html"}:
        raise HTTPException(404)
    return FileResponse(Path(__file__).parent / "static" / filename)


@app.post("/v1/documents", status_code=202)
def upload(file: UploadFile = File(...), source_json: str = Form("{}"), user: Principal = Depends(require("admin", "analyst"))):
    throttle(user, "upload", 30)
    try:
        source = json.loads(source_json)
        if not isinstance(source, dict) or len(source_json) > 4096:
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(422, "source_json must be a small JSON object")
    name = Path(file.filename or "unnamed").name[:200]
    cfg = settings()
    digest = hashlib.sha256()
    size = 0
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=cfg.data_dir, delete=False) as temporary:
        temporary_path = Path(temporary.name)
        try:
            while block := file.file.read(1024 * 1024):
                size += len(block)
                if size > cfg.max_upload_bytes:
                    raise HTTPException(413, "Upload too large")
                digest.update(block); temporary.write(block)
        except Exception:
            temporary_path.unlink(missing_ok=True)
            raise
    if not size:
        temporary_path.unlink(missing_ok=True)
        raise HTTPException(422, "Empty file")
    target_dir = cfg.data_dir / user.tenant
    target_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = target_dir / digest.hexdigest()
    try:
        with transaction() as conn:
            existing = conn.execute("SELECT id,status FROM documents WHERE tenant_id=%s AND sha256=%s",
                                    (user.tenant, digest.hexdigest())).fetchone()
            if existing:
                return {"id": existing["id"], "status": existing["status"], "duplicate": True}
            os.replace(temporary_path, target)
            target.chmod(0o600)
            doc_id, job_id = uuid.uuid4(), uuid.uuid4()
            conn.execute("INSERT INTO documents(id,tenant_id,filename,mime,sha256,byte_size,source,status) VALUES (%s,%s,%s,%s,%s,%s,%s,'queued')",
                         (doc_id, user.tenant, name, file.content_type or "application/octet-stream", digest.hexdigest(), size, Jsonb(source)))
            conn.execute("INSERT INTO jobs(id,tenant_id,document_id,status) VALUES (%s,%s,%s,'queued')",
                         (job_id, user.tenant, doc_id))
            audit(conn, user.tenant, str(user.key_id), "uploaded", str(doc_id), {"sha256": digest.hexdigest(), "bytes": size})
            return {"id": doc_id, "job_id": job_id, "status": "queued", "duplicate": False}
    finally:
        temporary_path.unlink(missing_ok=True)


@app.get("/v1/documents")
def documents(limit: int = 50, offset: int = 0, user: Principal = Depends(principal)):
    if not (1 <= limit <= 100 and 0 <= offset <= 100000):
        raise HTTPException(422, "Invalid pagination")
    throttle(user, "read")
    with transaction() as conn:
        return conn.execute("SELECT id,filename,mime,byte_size,source,status,language,created_at,processed_at,error "
                            "FROM documents WHERE tenant_id=%s ORDER BY created_at DESC LIMIT %s OFFSET %s",
                            (user.tenant, limit, offset)).fetchall()


def get_document(conn, user, doc_id):
    row = conn.execute("SELECT * FROM documents WHERE tenant_id=%s AND id=%s", (user.tenant, doc_id)).fetchone()
    if not row:
        raise HTTPException(404, "Document not found")
    return row


@app.get("/v1/documents/{doc_id}")
def document(doc_id: uuid.UUID, user: Principal = Depends(principal)):
    throttle(user, "read")
    with transaction() as conn:
        row = get_document(conn, user, doc_id)
        analysis = conn.execute("SELECT labels,signals,topology,predictions,explanation,model_version "
                                "FROM analyses WHERE tenant_id=%s AND document_id=%s", (user.tenant, doc_id)).fetchone()
        audit(conn, user.tenant, str(user.key_id), "viewed", str(doc_id))
        return {"id": row["id"], "filename": row["filename"], "status": row["status"], "error": row["error"],
                "source": row["source"], "metadata": row["metadata"], "language": row["language"],
                "content": row["content"][:30000], "content_truncated": len(row["content"]) > 30000,
                "analysis": analysis}


@app.get("/v1/documents/{doc_id}/explanation")
def explanation(doc_id: uuid.UUID, user: Principal = Depends(principal)):
    """On-demand SHAP of the explicit rule priority; optional train extra required."""
    throttle(user, "read")
    with transaction() as conn:
        get_document(conn, user, doc_id)
        row = conn.execute("SELECT labels,signals,explanation FROM analyses WHERE tenant_id=%s AND document_id=%s",
                           (user.tenant, doc_id)).fetchone()
    if not row:
        raise HTTPException(409, "Analysis not ready")
    if row["labels"].get("method") != "rules:v1":
        raise HTTPException(409, "SHAP is only configured for the rules:v1 score")
    try:
        from .explain import explain_priority
        return explain_priority(row["signals"], row["labels"], row["explanation"])
    except ImportError as exc:
        raise HTTPException(503, "Install the train extra to enable SHAP") from exc


@app.get("/v1/timeline")
def timeline(limit: int = 100, user: Principal = Depends(principal)):
    from .temporal import timeline as build_timeline
    if not 1 <= limit <= 250:
        raise HTTPException(422, "Invalid limit")
    throttle(user, "read")
    with transaction() as conn:
        rows = conn.execute("SELECT id,filename,status,source,created_at FROM documents WHERE tenant_id=%s "
                            "ORDER BY created_at DESC LIMIT %s", (user.tenant, limit)).fetchall()
    return build_timeline(rows)


@app.get("/v1/entities/candidates")
def entity_candidates(user: Principal = Depends(require("admin", "analyst"))):
    from .entities import candidates
    throttle(user, "read")
    with transaction() as conn:
        rows = conn.execute("SELECT id,canonical,kind FROM entities WHERE tenant_id=%s "
                            "ORDER BY canonical,id LIMIT 250", (user.tenant,)).fetchall()
    return candidates(rows)


class EntityMerge(BaseModel):
    source_id: uuid.UUID
    target_id: uuid.UUID


@app.post("/v1/entities/merge")
def merge_entities(payload: EntityMerge, user: Principal = Depends(require("admin"))):
    """Merge only after review; preserve original spelling as an alias and audit the operation."""
    if payload.source_id == payload.target_id:
        raise HTTPException(422, "Select two distinct entities")
    throttle(user, "merge", 10)
    with transaction() as conn:
        rows = conn.execute("SELECT id,canonical,kind FROM entities WHERE tenant_id=%s AND id=ANY(%s) "
                            "ORDER BY id FOR UPDATE", (user.tenant, [payload.source_id, payload.target_id])).fetchall()
        by_id = {row["id"]: row for row in rows}
        src, dst = by_id.get(payload.source_id), by_id.get(payload.target_id)
        if not src or not dst:
            raise HTTPException(404, "Entity not found")
        if src["kind"] != dst["kind"]:
            raise HTTPException(422, "Entity types differ")
        conflict = conn.execute("SELECT entity_id FROM entity_aliases WHERE tenant_id=%s AND kind=%s AND alias=%s",
                                (user.tenant, src["kind"], src["canonical"])).fetchone()
        if conflict and conflict["entity_id"] != dst["id"]:
            raise HTTPException(409, "Alias already assigned")
        conn.execute("INSERT INTO mentions(tenant_id,document_id,entity_id,start_offset,end_offset) "
                     "SELECT tenant_id,document_id,%s,start_offset,end_offset FROM mentions "
                     "WHERE tenant_id=%s AND entity_id=%s ON CONFLICT DO NOTHING", (dst["id"], user.tenant, src["id"]))
        conn.execute("DELETE FROM mentions WHERE tenant_id=%s AND entity_id=%s", (user.tenant, src["id"]))
        for field in ("source_id", "target_id"):
            conn.execute(f"UPDATE relations SET {field}=%s WHERE tenant_id=%s AND {field}=%s",
                         (dst["id"], user.tenant, src["id"]))
        conn.execute("UPDATE entity_aliases SET entity_id=%s WHERE tenant_id=%s AND entity_id=%s",
                     (dst["id"], user.tenant, src["id"]))
        conn.execute("INSERT INTO entity_aliases(tenant_id,kind,alias,entity_id,reviewer_key_id) "
                     "VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                     (user.tenant, src["kind"], src["canonical"], dst["id"], user.key_id))
        conn.execute("DELETE FROM entities WHERE id=%s AND tenant_id=%s", (src["id"], user.tenant))
        audit(conn, user.tenant, str(user.key_id), "entity_merged", str(dst["id"]),
              {"source_id": str(src["id"]), "alias": src["canonical"]})
    return {"canonical_id": dst["id"], "alias": src["canonical"]}


class SearchQuery(BaseModel):
    query: str = Field(min_length=2, max_length=1000)
    limit: int = Field(default=5, ge=1, le=20)


@app.post("/v1/search")
def search(payload: SearchQuery, user: Principal = Depends(principal)):
    from .embedding import embed
    throttle(user, "search", 30)
    with transaction() as conn:
        model_name = tenant_embedding(conn, user.tenant)
    vector = embed([payload.query], model_name)[0]
    with transaction() as conn:
        if tenant_embedding(conn, user.tenant, lock=True) != model_name:
            raise HTTPException(409, "Embedding model changed during search; retry")
        rows = conn.execute("SELECT c.document_id,c.ordinal,c.text,d.filename, 1-(c.embedding<=>%s) AS similarity "
                            "FROM chunks c JOIN documents d ON d.id=c.document_id AND d.tenant_id=c.tenant_id "
                            "WHERE c.tenant_id=%s AND c.embedding IS NOT NULL AND d.status='ready' "
                            "ORDER BY c.embedding<=>%s LIMIT %s", (vector, user.tenant, vector, payload.limit)).fetchall()
        audit(conn, user.tenant, str(user.key_id), "searched", "chunks", {"query_sha256": hashlib.sha256(payload.query.encode()).hexdigest()})
        return rows


@app.post("/v1/ask")
def ask(payload: SearchQuery, user: Principal = Depends(principal)):
    # Extractive answer: verbatim evidence with provenance; no fabricated LLM synthesis.
    matches = search(payload, user)
    return {"question": payload.query, "answer": "\n\n".join(item["text"][:600] for item in matches[:3])
            if matches else "Aucun passage pertinent dans les documents indexés.",
            "citations": [{"document_id": x["document_id"], "chunk": x["ordinal"], "similarity": x["similarity"]} for x in matches[:3]],
            "method": "extractive_retrieval"}


@app.get("/v1/graph")
def graph(limit: int = 150, user: Principal = Depends(principal)):
    if not 1 <= limit <= 500:
        raise HTTPException(422, "Invalid limit")
    throttle(user, "read")
    with transaction() as conn:
        edges = conn.execute("SELECT r.source_id,r.target_id,r.kind,r.confidence,r.document_id,r.evidence "
                             "FROM relations r WHERE r.tenant_id=%s ORDER BY r.created_at DESC LIMIT %s",
                             (user.tenant, limit)).fetchall()
        ids = list({x["source_id"] for x in edges} | {x["target_id"] for x in edges})
        nodes = conn.execute("SELECT id,canonical,kind FROM entities WHERE tenant_id=%s AND id=ANY(%s)",
                             (user.tenant, ids)).fetchall() if ids else []
        return {"nodes": nodes, "edges": edges}


class Feedback(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    accepted: bool
    comment: str = Field(default="", max_length=2000)


@app.post("/v1/documents/{doc_id}/feedback", status_code=201)
def feedback(doc_id: uuid.UUID, payload: Feedback, user: Principal = Depends(require("admin", "analyst"))):
    throttle(user, "feedback", 30)
    with transaction() as conn:
        get_document(conn, user, doc_id)
        feedback_id = uuid.uuid4()
        conn.execute("INSERT INTO feedback(id,tenant_id,document_id,actor_key_id,label,accepted,comment) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                     (feedback_id, user.tenant, doc_id, user.key_id, payload.label, payload.accepted, payload.comment))
        audit(conn, user.tenant, str(user.key_id), "reviewed", str(doc_id), {"feedback_id": str(feedback_id)})
        return {"id": feedback_id}


@app.get("/v1/audit")
def audit_log(limit: int = 100, user: Principal = Depends(require("admin"))):
    if not 1 <= limit <= 500:
        raise HTTPException(422)
    throttle(user, "read")
    with transaction() as conn:
        return conn.execute("SELECT actor,action,subject,details,created_at FROM audit_events WHERE tenant_id=%s "
                            "ORDER BY id DESC LIMIT %s", (user.tenant, limit)).fetchall()


@app.get("/v1/audit/verify")
def audit_verify(user: Principal = Depends(require("admin"))):
    throttle(user, "read")
    with transaction() as conn:
        return verify_audit(conn, user.tenant)


@app.get("/v1/monitoring")
def monitoring(user: Principal = Depends(require("admin"))):
    """Observed operational/feedback signals, not a statistical drift claim."""
    throttle(user, "read")
    with transaction() as conn:
        status = conn.execute("SELECT status,count(*) AS total FROM documents WHERE tenant_id=%s GROUP BY status",
                              (user.tenant,)).fetchall()
        versions = conn.execute("SELECT model_version,count(*) AS total FROM documents WHERE tenant_id=%s "
                                "AND model_version IS NOT NULL GROUP BY model_version", (user.tenant,)).fetchall()
        reviews = conn.execute("SELECT accepted,count(*) AS total FROM feedback WHERE tenant_id=%s "
                               "AND created_at>now()-interval '30 days' GROUP BY accepted", (user.tenant,)).fetchall()
        queue = conn.execute("SELECT count(*) AS pending FROM jobs WHERE tenant_id=%s AND status IN ('queued','running')",
                             (user.tenant,)).fetchone()
        return {"status": status, "model_versions": versions, "feedback_last_30_days": reviews,
                "pending_jobs": queue["pending"], "note": "Validate against labeled ground truth before claiming model drift."}


@app.get("/v1/exports/documents.csv")
def export_csv(user: Principal = Depends(require("admin", "analyst"))):
    throttle(user, "export", 10)
    with transaction() as conn:
        rows = conn.execute("SELECT id,filename,status,language,created_at,sha256 FROM documents WHERE tenant_id=%s "
                            "ORDER BY created_at DESC LIMIT 10000", (user.tenant,)).fetchall()
        audit(conn, user.tenant, str(user.key_id), "exported", "documents.csv", {"rows": len(rows)})
    output = io.StringIO(); writer = csv.writer(output)
    writer.writerow(["id", "filename", "status", "language", "created_at", "sha256"])
    for row in rows:
        writer.writerow([str(row[k]) for k in ("id", "filename", "status", "language", "created_at", "sha256")])
    return Response(output.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=documents.csv"})


@app.get("/v1/documents/{doc_id}/report.pdf")
def report(doc_id: uuid.UUID, user: Principal = Depends(require("admin", "analyst"))):
    from reportlab.pdfgen import canvas
    throttle(user, "export", 10)
    with transaction() as conn:
        row = get_document(conn, user, doc_id)
        analysis = conn.execute("SELECT labels,topology,predictions,explanation FROM analyses WHERE tenant_id=%s AND document_id=%s",
                                (user.tenant, doc_id)).fetchone()
        audit(conn, user.tenant, str(user.key_id), "exported", str(doc_id), {"type": "pdf"})
    buffer = io.BytesIO(); pdf = canvas.Canvas(buffer)
    lines = ["Mass Classification - Analyst report", f"Document: {doc_id}", f"Filename: {row['filename']}",
             f"SHA-256: {row['sha256']}", f"Status: {row['status']}",
             "All scores are review signals. An analyst must verify underlying evidence.",
             "Analysis: " + json.dumps(analysis or {}, default=str, ensure_ascii=True)[:2000]]
    y = 800
    for line in lines:
        for offset in range(0, len(line), 105):
            pdf.drawString(40, y, line[offset:offset+105]); y -= 16
            if y < 40:
                pdf.showPage(); y = 800
    pdf.save(); buffer.seek(0)
    return StreamingResponse(buffer, media_type="application/pdf", headers={"Content-Disposition": f"attachment; filename={doc_id}.pdf"})
