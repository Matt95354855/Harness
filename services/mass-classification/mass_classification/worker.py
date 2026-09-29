"""At-least-once job worker with leases, retry/backoff and atomic result writes."""
import hashlib
import json
import logging
from pathlib import Path
import signal
import time
import uuid
import threading

from psycopg.types.json import Jsonb

from .analysis import extract_features, classify, normalize_name
from .config import settings
from .db import transaction, migrate, audit, tenant_embedding
from .embedding import embed
from .extract import extract, chunks, ExtractionError
from .topology import graph_metrics, persistent_homology, incidence

log = logging.getLogger(__name__)
running = True


def claim():
    with transaction() as conn:
        return conn.execute("""
            UPDATE jobs SET status='running', attempts=attempts+1, lease_until=now()+interval '20 minutes'
            WHERE id=(SELECT id FROM jobs
                WHERE (status='queued' AND next_attempt_at<=now()) OR (status='running' AND lease_until<now())
                ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
            RETURNING id,tenant_id,document_id,attempts,max_attempts
        """).fetchone()


def process(job):
    cfg = settings()
    with transaction() as conn:
        doc = conn.execute("SELECT * FROM documents WHERE id=%s AND tenant_id=%s",
                           (job["document_id"], job["tenant_id"])).fetchone()
        if not doc:
            raise ValueError("Missing document")
        model_name = tenant_embedding(conn, job["tenant_id"])
        conn.execute("UPDATE documents SET status='processing' WHERE id=%s AND tenant_id=%s", (doc["id"], job["tenant_id"]))
    path = cfg.data_dir / job["tenant_id"] / doc["sha256"]
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != doc["sha256"]:
        raise ValueError("Stored file checksum mismatch")
    text, metadata = extract(path, doc["filename"], cfg.asr_model)
    pieces = chunks(text)[:500]
    truncated = len(text) > 500 * 800
    vectors = embed(pieces, model_name)
    mentions, relations, signals = extract_features(text, cfg.spacy_model)
    labels, explanation = classify(signals, text)
    # Restrict topology to extracted, evidenced relations; mere co-mentions are not edges.
    names = sorted({(normalize_name(m.text), m.kind) for m in mentions if len(m.text) > 2})[:20]
    accepted_names = {name for name, _ in names}
    graph_edges = sorted({(normalize_name(r.source), normalize_name(r.target))
                          for r in relations if normalize_name(r.source) in accepted_names
                          and normalize_name(r.target) in accepted_names
                          and normalize_name(r.source) != normalize_name(r.target)})
    topology = graph_metrics(graph_edges)
    topology["graph_basis"] = "pattern-extracted relations with source evidence; subject to human review"
    topology["distinct_entity_mentions"] = len(names)
    if graph_edges:
        try:
            topology["persistence"] = persistent_homology(graph_edges)
        except ImportError:
            topology["persistence"] = {"status": "gudhi_not_installed"}
    checkpoint = cfg.model_dir / "approved.pt"
    if checkpoint.exists() and graph_edges and len(names) >= 2:
        try:
            from .tnn import predict
            nodes, _, _, b1, b2 = incidence(graph_edges)
            node_vectors = embed(nodes, model_name)
            prediction = predict(checkpoint, node_vectors, b1, b2)
            explanation["attention_note"] = "Attention shows model focus, not a causal explanation."
        except (ValueError, RuntimeError, FileNotFoundError, KeyError) as exc:
            log.warning("Model prediction unavailable: %s", exc)
            prediction = {"status": "unavailable", "reason": "model_incompatible"}
    else:
        prediction = {"status": "unavailable", "reason": "no_approved_trained_model_or_graph"}
    metadata["embedding_truncated"] = truncated
    with transaction() as conn:
        if tenant_embedding(conn, job["tenant_id"], lock=True) != model_name:
            raise RuntimeError("Tenant embedding model changed; retry processing")
        conn.execute("DELETE FROM analyses WHERE document_id=%s AND tenant_id=%s", (doc["id"], job["tenant_id"]))
        conn.execute("DELETE FROM chunks WHERE document_id=%s AND tenant_id=%s", (doc["id"], job["tenant_id"]))
        conn.execute("DELETE FROM mentions WHERE document_id=%s AND tenant_id=%s", (doc["id"], job["tenant_id"]))
        conn.execute("DELETE FROM relations WHERE document_id=%s AND tenant_id=%s", (doc["id"], job["tenant_id"]))
        for i, (piece, vector) in enumerate(zip(pieces, vectors)):
            conn.execute("INSERT INTO chunks(id,tenant_id,document_id,ordinal,text,embedding) VALUES (%s,%s,%s,%s,%s,%s)",
                         (uuid.uuid4(), job["tenant_id"], doc["id"], i, piece, vector))
        entity_ids = {}
        for name, kind in names:
            row = conn.execute("SELECT entity_id AS id FROM entity_aliases WHERE tenant_id=%s AND kind=%s AND alias=%s",
                               (job["tenant_id"], kind, name)).fetchone()
            if row is None:
                row = conn.execute("INSERT INTO entities(id,tenant_id,canonical,kind) VALUES (%s,%s,%s,%s) "
                                   "ON CONFLICT(tenant_id,kind,canonical) DO UPDATE SET canonical=EXCLUDED.canonical RETURNING id",
                                   (uuid.uuid4(), job["tenant_id"], name, kind)).fetchone()
            entity_ids[(name, kind)] = row["id"]
        for mention in mentions:
            entity_id = entity_ids.get((normalize_name(mention.text), mention.kind))
            if entity_id:
                conn.execute("INSERT INTO mentions(tenant_id,document_id,entity_id,start_offset,end_offset) VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                             (job["tenant_id"], doc["id"], entity_id, mention.start, mention.end))
        for relation in relations:
            # Only link detected named entities; unsupported relations remain out of the graph.
            src = next((v for (n, _), v in entity_ids.items() if n == normalize_name(relation.source)), None)
            dst = next((v for (n, _), v in entity_ids.items() if n == normalize_name(relation.target)), None)
            if src and dst and src != dst:
                conn.execute("INSERT INTO relations(id,tenant_id,source_id,target_id,document_id,kind,confidence,evidence,extractor) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                             (uuid.uuid4(), job["tenant_id"], src, dst, doc["id"], relation.kind, relation.confidence, relation.evidence, relation.extractor))
        conn.execute("INSERT INTO analyses(document_id,tenant_id,labels,signals,topology,predictions,explanation,model_version) "
                     "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                     (doc["id"], job["tenant_id"], Jsonb(labels), Jsonb(signals), Jsonb(topology), Jsonb(prediction),
                      Jsonb(explanation), prediction.get("model_version", "rules:v1")))
        conn.execute("UPDATE documents SET content=%s,language=%s,metadata=%s,status='ready',error=NULL,processed_at=now(),model_version=%s WHERE id=%s AND tenant_id=%s",
                     (text, signals["language"], Jsonb(metadata), prediction.get("model_version", "rules:v1"), doc["id"], job["tenant_id"]))
        conn.execute("UPDATE jobs SET status='done',completed_at=now(),lease_until=NULL WHERE id=%s AND tenant_id=%s",
                     (job["id"], job["tenant_id"]))
        audit(conn, job["tenant_id"], "worker", "processed", str(doc["id"]), {"model": prediction.get("model_version")})


def fail(job, exc):
    error = f"{type(exc).__name__}: {str(exc)[:300]}"
    terminal = isinstance(exc, ExtractionError) or job["attempts"] >= job["max_attempts"]
    with transaction() as conn:
        conn.execute("UPDATE jobs SET status=%s,error=%s,lease_until=NULL,next_attempt_at=now()+(%s * interval '1 minute'),completed_at=CASE WHEN %s THEN now() ELSE NULL END WHERE id=%s AND tenant_id=%s",
                     ("failed" if terminal else "queued", error, 2 ** job["attempts"], terminal, job["id"], job["tenant_id"]))
        conn.execute("UPDATE documents SET status=%s,error=%s WHERE id=%s AND tenant_id=%s",
                     ("failed" if terminal else "queued", error, job["document_id"], job["tenant_id"]))
        audit(conn, job["tenant_id"], "worker", "processing_failed", str(job["document_id"]), {"terminal": terminal, "error": error})


def main():
    global running
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    signal.signal(signal.SIGTERM, lambda *_: globals().__setitem__("running", False))
    migrate()
    while running:
        job = claim()
        if job is None:
            time.sleep(2); continue
        stop_heartbeat = threading.Event()

        def heartbeat():
            while not stop_heartbeat.wait(60):
                try:
                    with transaction() as conn:
                        conn.execute("UPDATE jobs SET lease_until=now()+interval '20 minutes' WHERE id=%s AND tenant_id=%s AND status='running'",
                                     (job["id"], job["tenant_id"]))
                except Exception:
                    log.exception("Lease heartbeat failed")

        heart = threading.Thread(target=heartbeat, daemon=True)
        heart.start()
        try:
            process(job)
        except Exception as exc:
            log.exception("Processing failed for document %s", job["document_id"])
            fail(job, exc)
        finally:
            stop_heartbeat.set()
            heart.join(timeout=2)


if __name__ == "__main__":
    main()
