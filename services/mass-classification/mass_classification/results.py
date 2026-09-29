"""Versioned business outcome, independent of the processing lifecycle."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class LabelScore(BaseModel):
    model_config = ConfigDict(extra='forbid')
    label: str
    score: float = Field(ge=0, le=1)
    score_kind: Literal['heuristic'] = 'heuristic'


class RuleEvidence(BaseModel):
    document_id: str
    label: str
    matched_terms: list[str]
    kind: Literal['rule_terms_not_passage_citations'] = 'rule_terms_not_passage_citations'


class ClassificationResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: Literal['classification-result:v1'] = 'classification-result:v1'
    document_id: str
    status: Literal['classified', 'partial', 'abstained', 'failed']
    reasons: list[str]
    labels: list[LabelScore]
    review_priority: float | None = Field(default=None, ge=0, le=100)
    evidence: list[RuleEvidence]
    limitations: list[str]
    human_review_required: bool = True
    model_version: str | None = None
    neural_prediction_status: Literal['available_uncalibrated', 'unavailable'] = 'unavailable'


def classification_result(document: dict, analysis: dict | None) -> dict | None:
    status = document['status']
    if status in {'queued', 'processing'}:
        return None
    base = dict(document_id=str(document['id']), labels=[], evidence=[], reasons=[],
                limitations=['heuristic_scores_not_probabilities', 'ocr_quality_not_measured'])
    if status == 'failed':
        return ClassificationResult(**(base | {'status': 'failed', 'reasons': ['processing_failed']})).model_dump()
    if status != 'ready' or not analysis or analysis.get('labels', {}).get('method') != 'rules:v1':
        return ClassificationResult(**(base | {'status': 'failed', 'reasons': ['missing_or_unsupported_analysis']})).model_dump()
    labels = analysis['labels']
    scores = labels.get('domain_scores', {})
    evidence = analysis.get('explanation', {}).get('matched_terms', {})
    truncated = bool(document.get('metadata', {}).get('embedding_truncated'))
    outcome = 'partial' if scores and truncated else 'classified' if scores else 'abstained'
    reasons = ['index_truncated'] if scores and truncated else [] if scores else ['no_rule_label']
    limitations = base['limitations'] + (['index_truncated'] if truncated else [])
    neural = 'available_uncalibrated' if analysis.get('predictions', {}).get('classes') else 'unavailable'
    if neural == 'unavailable':
        limitations.append('neural_prediction_unavailable')
    return ClassificationResult(**(base | {
        'status': outcome, 'reasons': reasons, 'limitations': limitations,
        'labels': [LabelScore(label=name, score=score) for name, score in sorted(scores.items())],
        'review_priority': labels.get('review_priority'),
        'evidence': [RuleEvidence(document_id=str(document['id']), label=name, matched_terms=terms)
                     for name, terms in sorted(evidence.items()) if name in scores],
        'model_version': 'rules:v1', 'neural_prediction_status': neural,
    })).model_dump()
