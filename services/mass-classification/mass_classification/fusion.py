"""Conservative arbitration: neural scores remain diagnostic until calibrated."""
import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TAXONOMY = frozenset({'banking', 'investigation', 'media'})


class FusionDecision(BaseModel):
    model_config = ConfigDict(extra='forbid')
    policy: Literal['fusion:conservative:v1'] = 'fusion:conservative:v1'
    selected_engine: Literal['rules:v1'] | None = None
    rule_scores: dict[str, float] = Field(default_factory=dict)
    neural_scores: dict[str, float] = Field(default_factory=dict)
    neural_model_version: str | None = None
    neural_status: Literal['unavailable', 'uncalibrated', 'rejected'] = 'unavailable'
    agreement: Literal['not_comparable', 'overlap', 'disagreement', 'ambiguous'] = 'not_comparable'
    guards: list[str] = Field(default_factory=list)


def valid_scores(scores: object) -> bool:
    return isinstance(scores, dict) and all(
        isinstance(name, str) and isinstance(value, (int, float))
        and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 1
        for name, value in scores.items()
    )


def fuse(rule_scores: dict, predictions: object) -> FusionDecision:
    result = FusionDecision(rule_scores=rule_scores, selected_engine='rules:v1' if rule_scores else None)
    if not isinstance(predictions, dict):
        result.neural_status = 'rejected'
        result.guards.append('invalid_neural_prediction')
        return result
    scores = predictions.get('classes')
    if scores is None or scores == {}:
        result.guards.append('neural_prediction_unavailable')
        return result
    version = predictions.get('model_version')
    result.neural_model_version = version if isinstance(version, str) else None
    if not valid_scores(scores) or not math.isclose(sum(scores.values()), 1, abs_tol=1e-4):
        result.neural_status = 'rejected'
        result.guards.append('invalid_neural_scores')
        return result
    result.neural_scores = dict(sorted(scores.items()))
    if set(scores) != TAXONOMY:
        result.neural_status = 'rejected'
        result.guards.append('incompatible_neural_taxonomy')
        return result
    result.neural_status = 'uncalibrated'
    result.guards.append('neural_not_used_without_verified_calibration')
    # No metadata flag can override this policy. Softmax is not calibration.
    if rule_scores:
        top = [name for name, value in scores.items() if math.isclose(value, max(scores.values()), abs_tol=1e-8)]
        result.agreement = 'ambiguous' if len(top) != 1 else 'overlap' if top[0] in rule_scores else 'disagreement'
        if result.agreement in {'ambiguous', 'disagreement'}:
            result.guards.append('neural_' + result.agreement)
    return result
