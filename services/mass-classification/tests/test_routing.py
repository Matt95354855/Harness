import pytest
from mass_classification.routing import classification_plan


@pytest.mark.parametrize('format_,first', [('.pdf', 'ocr_pdf_pages'), ('.docx', 'ocr_docx_images')])
def test_plan_selects_document_pipeline(format_, first):
    profile = {'version': 'document-profile:v1', 'format': format_, 'encrypted': False, 'sha256': 'a' * 64}
    plan = classification_plan(profile, ocr_available=True)
    assert plan['status'] == 'planned'
    assert plan['stages'][0] == first
    assert plan['input_sha256'] == profile['sha256']
    assert plan['classification_abstention'] == 'not_implemented'
    assert plan == classification_plan(profile, ocr_available=True)


def test_missing_ocr_blocks_even_native_document():
    profile = {'version': 'document-profile:v1', 'format': '.docx', 'encrypted': False, 'native_text_present': True}
    plan = classification_plan(profile, ocr_available=False)
    assert plan['status'] == 'blocked'
    assert plan['stages'] == []
    assert plan['reasons'] == ['ocr_unavailable']


def test_unknown_profile_is_not_silently_routed():
    plan = classification_plan({}, ocr_available=True)
    assert plan['status'] == 'blocked' and plan['route'] is None
    assert 'unsupported_profile_version' in plan['reasons']
