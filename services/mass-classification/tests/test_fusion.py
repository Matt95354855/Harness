import pytest

from mass_classification.results import ClassificationResult, classification_result


def result(scores=None, predictions=None, metadata=None):
    return classification_result({'id': 'one', 'status': 'ready', 'metadata': metadata or {}}, {
        'labels': {'method': 'rules:v1', 'domain_scores': {'banking': .43} if scores is None else scores},
        'predictions': {} if predictions is None else predictions,
    })


@pytest.mark.parametrize('classes,agreement,status', [
    ({'banking': .8, 'media': .1, 'investigation': .1}, 'overlap', 'classified'),
    ({'banking': .1, 'media': .8, 'investigation': .1}, 'disagreement', 'partial'),
    ({'banking': .45, 'media': .45, 'investigation': .1}, 'ambiguous', 'partial'),
])
def test_arbitration_preserves_contributions(classes, agreement, status):
    output = result(predictions={'classes': classes, 'model_version': 'test', 'calibrated': True})
    assert output['status'] == status
    assert output['fusion']['agreement'] == agreement
    assert output['fusion']['neural_scores'] == classes
    assert output['fusion']['rule_scores'] == {'banking': .43}
    assert output['labels'][0]['score'] == .43
    assert output['fusion']['neural_status'] == 'uncalibrated'
    assert output['human_review_required']
    ClassificationResult.model_validate_json(ClassificationResult.model_validate(output).model_dump_json())


@pytest.mark.parametrize('classes', [
    {'banking': float('nan')}, {'banking': float('inf')}, {'banking': -1},
    {'banking': True}, {'banking': '1'}, ['banking'],
    {'banking': .8, 'media': .8, 'investigation': .1}, {'other': 1},
])
def test_invalid_neural_output_cannot_classify(classes):
    output = result(predictions={'classes': classes})
    assert output['status'] == 'partial'
    assert output['fusion']['neural_status'] == 'rejected'
    assert output['labels'][0]['score'] == .43


def test_neural_alone_cannot_replace_missing_rules():
    output = result(scores={}, predictions={'classes': {'banking': .98, 'media': .01, 'investigation': .01}})
    assert output['status'] == 'abstained'
    assert output['labels'] == []
    assert output['fusion']['selected_engine'] is None


def test_missing_neural_and_truncated_index():
    output = result(metadata={'embedding_truncated': True})
    assert output['status'] == 'partial'
    assert output['fusion']['neural_scores'] == {}
    assert 'index_truncated' in output['reasons']


@pytest.mark.parametrize('scores', [{'banking': float('nan')}, {'other': .5}, {'banking': True}])
def test_invalid_rules_fail_closed(scores):
    output = result(scores=scores)
    assert output['status'] == 'failed'
    assert output['labels'] == []
