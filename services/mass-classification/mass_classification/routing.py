"""Deterministic execution planning; never a classification confidence score."""


def classification_plan(profile: dict, *, ocr_available: bool) -> dict:
    reasons = []
    format_ = profile.get('format')
    if profile.get('version') != 'document-profile:v1':
        reasons.append('unsupported_profile_version')
    if format_ not in {'.pdf', '.docx'}:
        reasons.append('unsupported_format')
    if profile.get('encrypted') is not False:
        reasons.append('encrypted_or_unknown')
    if not ocr_available:
        reasons.append('ocr_unavailable')
    route = 'pdf_ocr_native' if format_ == '.pdf' else 'docx_image_ocr_native_tables' if format_ == '.docx' else None
    warnings = ['ocr_quality_not_measured', 'human_review_required_for_sensitive_decisions']
    if format_ == '.pdf':
        warnings.append('pdf_table_structure_not_guaranteed')
    elif format_ == '.docx':
        warnings.append('docx_reading_order_not_guaranteed')
    return {
        'version': 'classification-plan:v1',
        'status': 'blocked' if reasons else 'planned',
        'route': route,
        'input_sha256': profile.get('sha256'),
        'reasons': reasons,
        'warnings': warnings,
        'stages': [] if reasons else [
            'ocr_pdf_pages' if format_ == '.pdf' else 'ocr_docx_images',
            'native_pdf_text' if format_ == '.pdf' else 'native_docx_text_and_tables',
            'normalize_and_chunk', 'embed', 'nlp', 'rules:v1', 'evidence_graph',
        ],
        'topological_prediction': 'conditional_on_approved_compatible_weights_and_graph',
        'classification_abstention': 'no_rule_label_in_result_v1',
    }
