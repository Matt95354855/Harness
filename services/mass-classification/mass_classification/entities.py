"""Conservative, reviewable entity identity candidates; names alone never merge."""
from difflib import SequenceMatcher
import unicodedata

from .analysis import normalize_name


def key(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", normalize_name(value))
                   if not unicodedata.combining(c))


def candidates(entities: list[dict], threshold: float = 0.83) -> list[dict]:
    """Bounded O(n²) review suggestions within one tenant and one entity type."""
    if len(entities) > 250:
        raise ValueError("Candidate batch exceeds 250 entities")
    output = []
    for i, left in enumerate(entities):
        for right in entities[i + 1:]:
            if left["kind"] != right["kind"] or left["id"] == right["id"]:
                continue
            a, b = key(left["canonical"]), key(right["canonical"])
            if not a or not b or a == b:
                continue
            score = SequenceMatcher(None, a, b).ratio()
            if score >= threshold:
                output.append({"left": left, "right": right, "similarity": round(score, 3),
                               "status": "suggestion_only"})
    return sorted(output, key=lambda item: -item["similarity"])[:50]
