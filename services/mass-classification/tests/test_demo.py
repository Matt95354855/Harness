"""Exercise the entire local discovery workflow without PostgreSQL or ML downloads."""
from fastapi.testclient import TestClient

import mass_classification.demo as demo


def test_discovery_workflow(tmp_path, monkeypatch):
    monkeypatch.setattr(demo, "DATA_DIR", tmp_path)
    monkeypatch.setattr(demo, "DB_FILE", tmp_path / "demo.sqlite3")
    with TestClient(demo.app) as client:
        session = client.get("/v1/session")
        assert session.status_code == 200
        assert session.json()["mode"] == "demo"
        documents = client.get("/v1/documents").json()
        assert len(documents) == 3
        timeline = client.get("/v1/timeline").json()
        assert len(timeline) == 3 and {item["date_kind"] for item in timeline} == {"source_event", "import"}
        assert all(doc["source"]["type"] == "synthetic_example" for doc in documents)

        search = client.post("/v1/search", json={"query": "virement Nova"})
        assert search.status_code == 200
        assert search.json() and search.json()[0]["document_id"]
        answer = client.post("/v1/ask", json={"query": "Alice Martin"}).json()
        assert answer["citations"] and answer["method"] == "demo:lexical_retrieval"

        imported = client.post("/v1/documents", files={"file": ("note.txt", b"Note fictive : facture de 20 EUR")},
                               data={"source_json": '{"description":"Essai local"}'})
        assert imported.status_code == 202
        doc_id = imported.json()["id"]
        assert client.get("/static/offline.html").status_code == 200
        assert client.get(f"/v1/documents/{doc_id}").json()["analysis"]["labels"]["review_priority"] > 0
        duplicate = client.post("/v1/documents", files={"file": ("note.txt", b"Note fictive : facture de 20 EUR")})
        assert duplicate.json()["duplicate"]
        reviewed = client.post(f"/v1/documents/{doc_id}/feedback", json={"label": "finance", "accepted": True})
        assert reviewed.status_code == 201
        assert client.get("/v1/graph").json()["edges"]
        assert client.get("/v1/audit").json()[0]["action"] == "reviewed"
        assert client.get("/v1/exports/documents.csv").text.startswith("id,filename")
        assert client.get(f"/v1/documents/{doc_id}/report.pdf").content.startswith(b"%PDF")
        assert client.post("/v1/documents", files={"file": ("program.exe", b"unsafe")}).status_code == 415
