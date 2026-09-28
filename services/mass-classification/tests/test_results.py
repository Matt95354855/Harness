import pytest
from mass_classification.results import ClassificationResult, classification_result


def analysis(scores):
    return {'labels': {'method': 'rules:v1', 'domain_scores': scores, 'review_priority': 20},
            'explanation': {'matched_terms': {'banking': ['virement']}}, 'predictions': {'status': 'unavailable'}}


@pytest.mark.parametrize('status', ['queued', 'processing'])
def test_in_progress_has_no_business_outcome(status):
    assert classification_result({'id': 'one', 'status': status}, None) is None


@pytest.mark.parametrize('scores,metadata,expected', [
    ({'banking': .43}, {}, 'classified'),
    ({'banking': .43}, {'embedding_truncated': True}, 'partial'),
    ({}, {}, 'abstained'),
])
def test_terminal_rule_outcomes(scores, metadata, expected):
    result = classification_result({'id': 'one', 'status': 'ready', 'metadata': metadata}, analysis(scores))
    assert result['status'] == expected
    assert result['human_review_required']
    assert result['neural_prediction_status'] == 'unavailable'
    ClassificationResult.model_validate(result)
    if scores:
        assert result['labels'][0]['score_kind'] == 'heuristic'
        assert result['evidence'][0]['document_id'] == 'one'


def test_failure_has_no_invented_labels():
    result = classification_result({'id': 'one', 'status': 'failed'}, analysis({'banking': .43}))
    assert result['status'] == 'failed' and not result['labels']
    assert classification_result({'id': 'one', 'status': 'ready'}, None)['status'] == 'failed'
