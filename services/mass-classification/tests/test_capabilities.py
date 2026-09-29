from mass_classification.capabilities import classification_capabilities, validate_classification_filename
from mass_classification.extract import ExtractionError, _combine_ocr_and_native, extract


def test_unified_workflow_accepts_only_pdf_and_docx():
    assert validate_classification_filename("CASE.PDF") == "CASE.PDF"
    assert validate_classification_filename("report.docx") == "report.docx"
    for filename in ("notes.txt", "table.xlsx", "image.png", "archive.zip"):
        try:
            validate_classification_filename(filename)
        except ValueError:
            pass
        else:
            raise AssertionError(f"{filename} should be rejected")


def test_capabilities_require_ocr_before_native_extraction():
    result = classification_capabilities(max_upload_bytes=1234, ocr_available=True,
                                         approved_model_available=False)
    assert [item["extension"] for item in result["inputs"]] == [".pdf", ".docx"]
    stages = result["preprocessing"]["stages"]
    assert result["preprocessing"]["required"] is True
    assert stages[0]["name"] == "ocr" and stages[0]["order"] == 1
    assert stages[1]["name"] == "native_structure_extraction"
    assert result["classification"]["topological_model"]["status"] == "unavailable"
    assert result["classification"]["abstention_supported"] is True


def test_capabilities_report_missing_ocr_without_hiding_other_stages():
    result = classification_capabilities(max_upload_bytes=1234, ocr_available=False,
                                         approved_model_available=True)
    assert result["preprocessing"]["stages"][0]["status"] == "unavailable"
    assert result["preprocessing"]["stages"][1]["status"] == "available"
    assert result["classification"]["topological_model"]["status"] == "available"


def test_ocr_text_precedes_native_text_without_exact_duplication():
    assert _combine_ocr_and_native("OCR visible", "Texte natif") == "OCR visible\nTexte natif"
    assert _combine_ocr_and_native("OCR visible Texte natif", "Texte natif") == "OCR visible Texte natif"
    assert _combine_ocr_and_native("", "Texte natif") == "Texte natif"


def test_pdf_and_docx_signatures_must_match_extensions(tmp_path):
    fake_pdf = tmp_path / "fake.pdf"
    fake_pdf.write_bytes(b"not a PDF")
    fake_docx = tmp_path / "fake.docx"
    fake_docx.write_bytes(b"not a DOCX")
    for path in (fake_pdf, fake_docx):
        try:
            extract(path, path.name)
        except ExtractionError:
            pass
        else:
            raise AssertionError(f"{path.name} should be rejected")
