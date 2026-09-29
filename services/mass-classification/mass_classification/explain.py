"""SHAP attribution for the *rule* review queue score, never a fraud probability."""
import numpy as np


FEATURES = ("money_mentions", "domains", "urgency_mentions")


def rule_score(values: np.ndarray) -> np.ndarray:
    matrix = np.atleast_2d(values)
    return np.minimum(100, matrix @ np.array([8, 4, 2])).astype(float)


def explain_priority(signals: dict, labels: dict, matched_terms: dict) -> dict:
    """Use a zero baseline; contributions sum to the displayed capped score."""
    import shap

    values = np.array([[signals.get("money_mentions", 0),
                        len(labels.get("domain_scores", {})),
                        matched_terms.get("urgency_mentions", 0)]], dtype=float)
    if not np.isfinite(values).all() or (values < 0).any():
        raise ValueError("Invalid rule inputs")
    background = np.zeros((1, 3))
    explanation = shap.Explainer(rule_score, shap.maskers.Independent(background),
                                 algorithm="exact", feature_names=list(FEATURES))(values)
    return {"method": "shap:exact:rules:v1", "baseline": float(np.ravel(explanation.base_values)[0]),
            "score": float(rule_score(values)[0]),
            "contributions": dict(zip(FEATURES, [float(x) for x in explanation.values[0]])),
            "limitations": "Attribution du score de priorité défini par des règles, sans interprétation causale ni prédiction de fraude."}
