"""NLP and evidence grounded analytical signals. Scores are review priorities, not findings."""
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
import re

import numpy as np


@dataclass(frozen=True)
class Mention:
    text: str
    kind: str
    start: int
    end: int


@dataclass(frozen=True)
class Relation:
    source: str
    target: str
    kind: str
    confidence: float
    evidence: str
    extractor: str


_nlp = None


def nlp(model_name: str):
    global _nlp
    if _nlp is None:
        import spacy
        _nlp = spacy.load(model_name)
    return _nlp


def normalize_name(value: str) -> str:
    return re.sub(r"\s+", " ", value.casefold().strip().strip(".,;:"))


def extract_features(text: str, model_name: str) -> tuple[list[Mention], list[Relation], dict]:
    from langdetect import detect, LangDetectException
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    doc = nlp(model_name)(text[:100_000])
    mentions = [Mention(e.text, e.label_, e.start_char, e.end_char) for e in doc.ents]
    # Preserve locations and exact evidence. Do not infer guilt or trustworthiness.
    amount_pattern = r"(?<!\w)(?:[$€£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:EUR|USD|GBP))(?!\w)"
    mentions.extend(Mention(m.group(), "MONEY", m.start(), m.end()) for m in re.finditer(amount_pattern, text[:100_000]))
    mentions.sort(key=lambda m: (m.start, m.end))
    patterns = {
        "works_at": re.compile(r"\b(?P<a>[A-Z][\w-]+(?:\s+[A-Z][\w-]+)?)\s+(?:works for|works at|travaille chez)\s+(?P<b>[A-Z][\w-]+(?:\s+[A-Z][\w-]+)?)", re.I),
        "transferred_to": re.compile(r"\b(?P<a>[A-Z][\w-]+)\s+(?:transferred to|a transféré à)\s+(?P<b>[A-Z][\w-]+)", re.I),
    }
    relations = [Relation(m.group("a"), m.group("b"), kind, 0.75, m.group()[:250], "pattern:v1")
                 for kind, pattern in patterns.items() for m in pattern.finditer(text[:100_000])]
    try:
        language = detect(text[:5000])
    except LangDetectException:
        language = "unknown"
    sentiment = SentimentIntensityAnalyzer().polarity_scores(text[:5000])["compound"] if language == "en" else None
    words = re.findall(r"\b\w+\b", text[:100_000].lower())
    features = {
        "language": language, "sentiment_en": sentiment, "word_count": len(words),
        "lexical_diversity": round(len(set(words)) / max(1, len(words)), 4),
        "entity_count": len(mentions), "money_mentions": sum(m.kind == "MONEY" for m in mentions),
        "uppercase_ratio": round(sum(c.isupper() for c in text) / max(1, sum(c.isalpha() for c in text)), 4),
        "punctuation_bursts": len(re.findall(r"[!?]{3,}", text)),
        "top_terms": Counter(w for w in words if len(w) > 4).most_common(10),
    }
    return mentions, relations, features


def classify(features: dict, text: str) -> tuple[dict, dict]:
    """Transparent baseline labels; replace with a validated customer model for decisions."""
    terms = text.casefold()
    rules = {
        "banking": ("transaction", "virement", "iban", "account", "compte bancaire"),
        "investigation": ("enquête", "investigation", "evidence", "preuve"),
        "media": ("article", "news", "publication", "press"),
    }
    hits = {label: [word for word in words if word in terms] for label, words in rules.items()}
    labels = {label: min(0.95, 0.25 + len(matches) * 0.18) for label, matches in hits.items() if matches}
    # Heuristic queue priority, not fraud probability or credibility rating.
    urgency = len(re.findall(r"\b(?:urgent|immédiat)\b", terms))
    priority = min(100, features["money_mentions"] * 8 + len(labels) * 4 + urgency * 2)
    return {"domain_scores": labels, "review_priority": priority, "method": "rules:v1"}, {
        "matched_terms": {k: v for k, v in hits.items() if v},
        "priority_contributions": {"money_mentions": features["money_mentions"] * 8, "domains": len(labels) * 4, "urgency_mentions": urgency * 2},
        "urgency_mentions": urgency,
        "limitations": "Rules flag documents for human review; they do not establish fraud, intent or credibility.",
    }


def anomaly_scores(values: list[float]) -> list[float]:
    """Robust rolling deviation on an ordered series; no baseline implies no anomaly."""
    if len(values) < 5:
        return [0.0] * len(values)
    scores = []
    for idx, value in enumerate(values):
        prior = np.asarray(values[max(0, idx - 30):idx], dtype=float)
        if len(prior) < 5:
            scores.append(0.0); continue
        median = float(np.median(prior))
        mad = float(np.median(np.abs(prior - median)))
        scores.append(round(abs(value - median) / max(1.0, 1.4826 * mad), 3))
    return scores


def coordination(events: list[tuple[datetime, str]], window_seconds: int = 300) -> dict:
    """Descriptive coincidence only; separate accounts must be supplied by trusted provenance."""
    if len(events) < 2:
        return {"score": 0.0, "distinct_sources": len({e[1] for e in events})}
    ordered = sorted(events)
    best = 0
    for time, _ in ordered:
        sources = {source for stamp, source in ordered if 0 <= (stamp - time).total_seconds() <= window_seconds}
        best = max(best, len(sources))
    return {"score": round(best / max(1, len({s for _, s in events})), 3),
            "distinct_sources": len({s for _, s in events}), "window_seconds": window_seconds}


def narrative_clusters(vectors: np.ndarray, min_similarity: float = 0.85) -> list[list[int]]:
    """Cluster normalized document vectors; provenance/time must be inspected separately."""
    if not len(vectors):
        return []
    if len(vectors) > 1000:
        raise ValueError("Narrative analysis requires a bounded batch")
    from sklearn.metrics.pairwise import cosine_similarity
    from sklearn.cluster import AgglomerativeClustering
    if len(vectors) == 1:
        return [[0]]
    distances = np.maximum(0.0, 1 - cosine_similarity(vectors))
    cluster_ids = AgglomerativeClustering(n_clusters=None, distance_threshold=1-min_similarity,
                                          metric="precomputed", linkage="average").fit_predict(distances)
    return [[int(i) for i in np.where(cluster_ids == cluster)[0]] for cluster in sorted(set(cluster_ids))]


def transition_forecast(histories: list[list[str]], current: str) -> dict:
    """Empirical next-state frequencies with sample size; no history means no forecast."""
    counts: Counter = Counter()
    for sequence in histories:
        counts.update(b for a, b in zip(sequence, sequence[1:]) if a == current)
    total = sum(counts.values())
    return {"current": current, "support": total, "next": {name: n/total for name, n in counts.items()} if total else {},
            "status": "available" if total >= 30 else "insufficient_history"}
