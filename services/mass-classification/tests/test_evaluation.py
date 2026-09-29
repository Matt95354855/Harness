import copy
import json

import pytest

from mass_classification.evaluation import Corpus, Run, evaluate, main, read_json
from mass_classification.results import classification_result


def inputs():
    documents, observations = [], []
    for i, (truth, predicted, state) in enumerate([
        (['banking'], {'banking': .8}, 'ready'),
        (['media'], {'banking': .4}, 'ready'),
        (['investigation'], {}, 'ready'),
        (['banking'], {}, 'failed'),
    ]):
        doc_id, digest = str(i), f'{i:064x}'
        documents.append(dict(document_id=doc_id, sha256=digest, group_id=doc_id,
                              split='test', format='pdf' if i % 2 == 0 else 'docx', labels=truth))
        result = classification_result({'id': doc_id, 'status': state}, {
            'labels': {'method': 'rules:v1', 'domain_scores': predicted}})
        observations.append({'sha256': digest, 'result': result})
    return ({'version': 'classification-corpus:v1', 'dataset_id': 'synthetic-unit',
             'annotation_provenance': 'hand-authored test cases', 'synthetic': True, 'documents': documents},
            {'version': 'classification-evaluation-run:v1', 'run_id': 'unit', 'source_revision': 'fixture',
             'configuration_id': 'rules:v1', 'observations': observations})


def report(corpus, run):
    return evaluate(Corpus.model_validate(corpus), Run.model_validate(run))


def test_hand_computed_metrics_include_abstention_and_failure():
    output = report(*inputs())
    overall = output['overall']
    assert overall['micro']['tp'] == 1
    assert overall['micro']['fp'] == 1
    assert overall['micro']['fn'] == 3
    assert overall['micro']['precision'] == .5
    assert overall['micro']['recall'] == .25
    assert overall['micro']['f1'] == pytest.approx(1 / 3)
    assert overall['label_coverage'] == .5
    assert overall['exact_label_match_all'] == .25
    assert overall['exact_label_match_emitted'] == .5
    assert overall['failure_rate'] == overall['abstention_rate'] == .25
    assert output['by_format']['pdf']['documents'] == 2
    assert output['neural_diagnostics']['brier_sum'] is None
    assert not output['neural_diagnostics']['approval_granted']


@pytest.mark.parametrize('mutation', ['duplicate_id', 'duplicate_hash', 'family_leak', 'label', 'duplicate_label'])
def test_invalid_corpus(mutation):
    corpus, _ = inputs()
    docs = corpus['documents']
    if mutation == 'duplicate_id': docs[1]['document_id'] = docs[0]['document_id']
    if mutation == 'duplicate_hash': docs[1]['sha256'] = docs[0]['sha256']
    if mutation == 'family_leak':
        docs[1]['group_id'] = docs[0]['group_id']
        docs[1]['split'] = 'train'
    if mutation == 'label': docs[0]['labels'] = ['unknown']
    if mutation == 'duplicate_label': docs[0]['labels'] *= 2
    with pytest.raises(ValueError): Corpus.model_validate(corpus)


@pytest.mark.parametrize('mutation', ['missing', 'extra', 'duplicate', 'hash', 'state', 'duplicate_label'])
def test_invalid_observations(mutation):
    corpus, run = inputs()
    obs = run['observations']
    if mutation == 'missing': obs.pop()
    if mutation == 'extra':
        extra = copy.deepcopy(obs[0]); extra['result']['document_id'] = 'extra'; obs.append(extra)
    if mutation == 'duplicate': obs.append(obs[0])
    if mutation == 'hash': obs[0]['sha256'] = 'f' * 64
    if mutation == 'state': obs[0]['result']['status'] = 'failed'
    if mutation == 'duplicate_label': obs[0]['result']['labels'] *= 2
    with pytest.raises(ValueError): report(corpus, run)


def test_neural_diagnostics_and_no_approval():
    corpus, run = inputs()
    corpus['documents'] = corpus['documents'][:1]
    run['observations'] = run['observations'][:1]
    run['observations'][0]['result']['fusion'].update(
        neural_status='uncalibrated', neural_model_version='unit-model',
        neural_scores={'banking': .8, 'media': .1, 'investigation': .1})
    diagnostics = report(corpus, run)['neural_diagnostics']
    assert diagnostics['brier_sum'] == pytest.approx(.06)
    assert diagnostics['top_label_ece_10_bins'] == pytest.approx(.2)
    assert diagnostics['eligible_documents'] == 1
    assert diagnostics['approval_granted'] is False
    corpus['documents'][0]['labels'] = ['banking', 'media']
    assert report(corpus, run)['neural_diagnostics']['eligible_documents'] == 0


def test_empty_stratum_no_fake_zero():
    corpus, run = inputs()
    for doc in corpus['documents']: doc['format'] = 'pdf'
    assert report(corpus, run)['by_format']['docx']['micro']['recall'] is None


def test_multiple_model_versions_rejected():
    corpus, run = inputs()
    for i, obs in enumerate(run['observations']):
        obs['result']['fusion'].update(neural_status='uncalibrated', neural_model_version=str(i),
                                       neural_scores={'banking': 1.0, 'media': 0.0, 'investigation': 0.0})
    with pytest.raises(ValueError, match='model versions'): report(corpus, run)


@pytest.mark.parametrize('raw', ['{"a": 1, "a": 2}', '{"score": NaN}', '{"score": Infinity}'])
def test_invalid_json(tmp_path, raw):
    path = tmp_path / 'input.json'; path.write_text(raw)
    with pytest.raises(ValueError): read_json(path)


def test_cli_report_hashes_and_overwrite_protection(tmp_path):
    corpus, run = inputs()
    c, r, out = (tmp_path / name for name in ('corpus.json', 'run.json', 'report.json'))
    c.write_text(json.dumps(corpus)); r.write_text(json.dumps(run))
    args = ['--corpus', str(c), '--predictions', str(r), '--output', str(out)]
    main(args)
    saved = out.read_bytes()
    assert len(json.loads(saved)['inputs_sha256']['corpus']) == 64
    with pytest.raises(SystemExit) as exc: main(args)
    assert exc.value.code == 2
    assert out.read_bytes() == saved


def test_split_selection_and_determinism():
    corpus, run = inputs()
    original = report(corpus, run)
    run['observations'].reverse()
    assert report(corpus, run) == original
    with pytest.raises(ValueError): evaluate(Corpus.model_validate(corpus), Run.model_validate(run), 'train')
    with pytest.raises(ValueError): evaluate(Corpus.model_validate(corpus), Run.model_validate(run), 'calibration')
