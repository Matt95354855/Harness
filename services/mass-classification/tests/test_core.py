import io
import json
from pathlib import Path
import zipfile

import numpy as np
import pytest

from mass_classification.extract import ExtractionError, chunks, extract
from mass_classification.analysis import anomaly_scores, coordination, classify
from mass_classification.topology import graph_metrics, incidence, persistent_homology


def test_text_extraction_and_no_binary_execution(tmp_path):
    file = tmp_path / "case.json"
    file.write_text(json.dumps({"transaction": "EUR 100"}))
    text, meta = extract(file, file.name)
    assert "transaction" in text and meta["format"] == ".json"
    file.write_bytes(b"\x00 malicious")
    with pytest.raises(ExtractionError):
        extract(file, "case.txt")


def test_zip_expansion_and_path_traversal(tmp_path):
    file = tmp_path / "archive.zip"
    with zipfile.ZipFile(file, "w") as archive:
        archive.writestr("../outside.txt", "hidden")
        archive.writestr("safe.txt", "investigation notes")
    text, _ = extract(file, file.name)
    assert "investigation notes" in text and "hidden" not in text


def test_chunks_have_overlap():
    assert chunks("abcdefghij", size=6, overlap=2) == ["abcdef", "efghij", "ij"]


def test_boundary_operator_and_triangle_cycle():
    links = [("a", "b"), ("b", "c"), ("a", "c")]
    nodes, edges, triangles, b1, b2 = incidence(links)
    assert len(triangles) == 1 and np.allclose(b1 @ b2, 0)
    metrics = graph_metrics(links)
    assert metrics["betti_0"] == 1 and metrics["betti_1_graph"] == 1


def test_persistent_triangle_fills_cycle():
    pytest.importorskip("gudhi")
    topology = persistent_homology([("a", "b"), ("b", "c"), ("a", "c")])
    assert topology["simplices"] == 7


def test_anomaly_needs_history():
    assert anomaly_scores([1, 1, 1]) == [0.0] * 3
    assert anomaly_scores([1, 1, 1, 1, 1, 50])[-1] > 10


def test_heuristic_is_explained_not_probability():
    labels, explanation = classify({"money_mentions": 2}, "Virement IBAN account")
    assert labels["review_priority"] == 20
    assert "limitations" in explanation
