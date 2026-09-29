"""Offline evaluation of frozen results against independently annotated documents.

No inference, network calls, threshold fitting or model approval occurs here.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .fusion import TAXONOMY, valid_scores
from .results import ClassificationResult


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Annotation(StrictModel):
    document_id: str = Field(min_length=1)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    group_id: str = Field(min_length=1)
    split: Literal['train', 'calibration', 'test']
    format: Literal['pdf', 'docx']
    labels: list[Literal['banking', 'investigation', 'media']]

    @model_validator(mode='after')
    def unique_labels(self):
        if len(self.labels) != len(set(self.labels)):
            raise ValueError('duplicate annotation labels')
        return self


class Corpus(StrictModel):
    version: Literal['classification-corpus:v1']
    dataset_id: str = Field(min_length=1)
    annotation_provenance: str = Field(min_length=1)
    synthetic: bool
    documents: list[Annotation] = Field(min_length=1)

    @model_validator(mode='after')
    def isolation(self):
        ids, hashes, groups = set(), set(), {}
        for doc in self.documents:
            if doc.document_id in ids or doc.sha256 in hashes:
                raise ValueError('duplicate document ID or content hash in corpus')
            if doc.group_id in groups and groups[doc.group_id] != doc.split:
                raise ValueError('document family appears in multiple splits')
            ids.add(doc.document_id)
            hashes.add(doc.sha256)
            groups[doc.group_id] = doc.split
        return self


class Observation(StrictModel):
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    result: ClassificationResult


class Run(StrictModel):
    version: Literal['classification-evaluation-run:v1']
    run_id: str = Field(min_length=1)
    source_revision: str = Field(min_length=1)
    configuration_id: str = Field(min_length=1)
    observations: list[Observation] = Field(min_length=1)


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def metrics(rows):
    states = Counter(result.status for _, result in rows)
    counts = {name: {'tp': 0, 'fp': 0, 'fn': 0, 'support': 0} for name in sorted(TAXONOMY)}
    exact = emitted = 0
    for doc, result in rows:
        predicted = {item.label for item in result.labels}
        truth = set(doc.labels)
        has_output = result.status in {'classified', 'partial'}
        emitted += has_output
        exact += has_output and predicted == truth
        for name, count in counts.items():
            count['tp'] += name in predicted and name in truth
            count['fp'] += name in predicted and name not in truth
            count['fn'] += name not in predicted and name in truth
            count['support'] += name in truth
    def scores(count):
        tp, fp, fn = (count[k] for k in ('tp', 'fp', 'fn'))
        return count | {'precision': ratio(tp, tp + fp), 'recall': ratio(tp, tp + fn),
                        'f1': ratio(2 * tp, 2 * tp + fp + fn)}
    per_label = {name: scores(count) for name, count in counts.items()}
    total = {k: sum(c[k] for c in counts.values()) for k in ('tp', 'fp', 'fn', 'support')}
    f1s = [c['f1'] for c in per_label.values() if c['f1'] is not None]
    return {'documents': len(rows), 'statuses': {s: states[s] for s in ('classified', 'partial', 'abstained', 'failed')},
            'label_coverage': ratio(emitted, len(rows)), 'abstention_rate': ratio(states['abstained'], len(rows)),
            'failure_rate': ratio(states['failed'], len(rows)),
            'exact_label_match_all': ratio(exact, len(rows)),
            'exact_label_match_emitted': ratio(exact, emitted),
            'micro': scores(total), 'macro_f1_defined_labels': ratio(sum(f1s), len(f1s)),
            'per_label': per_label}


def neural_diagnostics(rows):
    """Brier sum and 10-bin top-label ECE on compatible single-label rows only."""
    eligible, excluded, versions = [], Counter(), set()
    for doc, result in rows:
        fusion = result.fusion
        if fusion.neural_status != 'uncalibrated':
            excluded['unavailable_or_rejected'] += 1
            continue
        scores = fusion.neural_scores
        if (not valid_scores(scores) or set(scores) != TAXONOMY
                or abs(sum(scores.values()) - 1) > 1e-4):
            raise ValueError('invalid neural distribution in evaluation result')
        if len(doc.labels) != 1:
            excluded['not_single_label'] += 1
            continue
        if not fusion.neural_model_version:
            excluded['missing_model_version'] += 1
            continue
        versions.add(fusion.neural_model_version)
        top = max(sorted(scores), key=scores.get)  # reproducible lexical tie break
        eligible.append((max(scores.values()), int(top == doc.labels[0]),
                         sum((p - int(label == doc.labels[0])) ** 2 for label, p in scores.items())))
    if len(versions) > 1:
        raise ValueError('cannot pool calibration diagnostics across model versions')
    bins = [{'count': 0, 'confidence_sum': 0.0, 'correct': 0} for _ in range(10)]
    for confidence, correct, _ in eligible:
        bucket = bins[min(int(confidence * 10), 9)]
        bucket['count'] += 1
        bucket['confidence_sum'] += confidence
        bucket['correct'] += correct
    n = len(eligible)
    return {'eligible_documents': n, 'excluded': dict(sorted(excluded.items())),
            'model_version': next(iter(versions), None),
            'brier_sum': ratio(sum(x[2] for x in eligible), n),
            'top_label_ece_10_bins': ratio(sum(abs(b['confidence_sum'] - b['correct']) for b in bins), n),
            'bins': [{'count': b['count'], 'mean_confidence': ratio(b['confidence_sum'], b['count']),
                      'accuracy': ratio(b['correct'], b['count'])} for b in bins],
            'approval_granted': False}


def evaluate(corpus: Corpus, run: Run, split: str = 'test') -> dict:
    if split not in {'test', 'calibration'}:
        raise ValueError('evaluation split must be test or calibration')
    selected = {d.document_id: d for d in corpus.documents if d.split == split}
    if not selected:
        raise ValueError('selected split is empty')
    observed = {}
    for item in run.observations:
        result = item.result
        if result.document_id in observed:
            raise ValueError('duplicate result')
        names = [label.label for label in result.labels]
        if len(names) != len(set(names)) or not set(names).issubset(TAXONOMY):
            raise ValueError('duplicate or unsupported result labels')
        if bool(names) != (result.status in {'classified', 'partial'}):
            raise ValueError('result labels inconsistent with terminal status')
        observed[result.document_id] = item
    if set(observed) != set(selected):
        raise ValueError('results must cover exactly the selected split, including failures')
    rows = []
    for document_id in sorted(selected):
        doc, observation = selected[document_id], observed[document_id]
        if doc.sha256 != observation.sha256:
            raise ValueError('result content hash does not match annotated document')
        rows.append((doc, observation.result))
    return {'version': 'classification-evaluation-report:v1', 'dataset_id': corpus.dataset_id,
            'synthetic': corpus.synthetic, 'annotation_provenance': corpus.annotation_provenance,
            'run_id': run.run_id, 'source_revision': run.source_revision,
            'configuration_id': run.configuration_id, 'split': split,
            'overall': metrics(rows),
            'by_format': {fmt: metrics([r for r in rows if r[0].format == fmt]) for fmt in ('pdf', 'docx')},
            'neural_diagnostics': neural_diagnostics(rows),
            'limitations': ['synthetic_not_business_evidence'] * corpus.synthetic + [
                'annotations_and_run_provenance_are_declared_not_authenticated',
                'near_duplicate_detection_requires_curated_group_ids',
                'no_ocr_quality_or_llm_tool_selection_measurement',
                'no_threshold_fitting_or_model_approval',
                'no_statistical_confidence_intervals']}


def read_json(path):
    raw = path.read_bytes()
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    def nonfinite(value):
        raise ValueError('non-finite JSON number')
    return json.loads(raw, object_pairs_hook=unique, parse_constant=nonfinite), hashlib.sha256(raw).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--predictions', type=Path, required=True)
    parser.add_argument('--split', choices=['test', 'calibration'], default='test')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        corpus, corpus_hash = read_json(args.corpus)
        run, run_hash = read_json(args.predictions)
        report = evaluate(Corpus.model_validate(corpus), Run.model_validate(run), args.split)
        report['inputs_sha256'] = {'corpus': corpus_hash, 'predictions': run_hash}
        # Exclusive create protects previous reports and source files.
        with args.output.open('x', encoding='utf-8') as stream:
            stream.write(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    except (ValueError, OSError) as exc:
        # Do not echo annotation values or paths from potentially sensitive inputs.
        parser.exit(2, f'Evaluation rejected ({type(exc).__name__}); check input schema, coverage and output path.\n')
    print(f"Evaluated {report['overall']['documents']} documents; model approval: false")


if __name__ == '__main__':
    main()
