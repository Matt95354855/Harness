"""Bounded structural profiling, without OCR, model calls or extracted text output."""
import hashlib
from pathlib import Path
import zipfile
from xml.etree import ElementTree

from .extract import ExtractionError

WORD = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def profile_document(path: Path, filename: str, max_bytes: int = 52428800) -> dict:
    size = path.stat().st_size
    if not 0 < size <= max_bytes:
        raise ExtractionError('Document size outside allowed bounds')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        signature = stream.read(8)
        stream.seek(0)
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    extension = Path(filename).suffix.lower()
    profile = {
        'version': 'document-profile:v1', 'format': extension,
        'bytes': size, 'sha256': digest.hexdigest(),
        'ocr_required': True, 'language': 'unknown',
        'ocr_quality': 'not_measured', 'sensitivity': 'not_assessed',
        'pages': None, 'images': 0, 'tables': None,
        'native_text_present': False, 'encrypted': False,
    }
    if extension == '.pdf':
        if not signature.startswith(b'%PDF'):
            raise ExtractionError('Invalid PDF signature')
        import pymupdf
        try:
            with pymupdf.open(path) as document:
                if document.needs_pass:
                    raise ExtractionError('Encrypted PDF requires manual review')
                if not 0 < len(document) <= 1000:
                    raise ExtractionError('PDF page limit exceeded')
                profile['pages'] = len(document)
                for page in document:
                    profile['images'] += len(page.get_images())
                    if page.get_text().strip():
                        profile['native_text_present'] = True
        except pymupdf.FileDataError as exc:
            raise ExtractionError('Corrupt PDF') from exc
        profile['image_count_basis'] = 'image_references_per_page'
        profile['table_structure'] = 'unknown_until_layout_analysis'
    elif extension == '.docx':
        try:
            with zipfile.ZipFile(path) as archive:
                members = archive.infolist()
                if len(members) > 2000 or sum(item.file_size for item in members) > 100_000_000:
                    raise ExtractionError('DOCX expansion limit exceeded')
                names = [item.filename for item in members]
                if len(names) != len(set(names)):
                    raise ExtractionError('Ambiguous duplicate DOCX entries')
                if '[Content_Types].xml' not in names or 'word/document.xml' not in names:
                    raise ExtractionError('Invalid DOCX container')
                if any(item.flag_bits & 1 for item in members):
                    raise ExtractionError('Encrypted DOCX requires manual review')
                xml = archive.read('word/document.xml')
                if len(xml) > 10_000_000 or b'<!DOCTYPE' in xml or b'<!ENTITY' in xml:
                    raise ExtractionError('Unsafe or oversized DOCX XML')
                document = ElementTree.fromstring(xml)
                profile['native_text_present'] = any((item.text or '').strip() for item in document.iter(WORD + 't'))
                profile['tables'] = sum(1 for _ in document.iter(WORD + 'tbl'))
                profile['images'] = sum(name.startswith('word/media/') and not name.endswith('/') for name in names)
                profile['table_structure'] = 'native_xml'
                profile['image_count_basis'] = 'embedded_media_files'
        except (zipfile.BadZipFile, ElementTree.ParseError, RuntimeError) as exc:
            raise ExtractionError('Corrupt or unsupported DOCX') from exc
    else:
        raise ExtractionError('Only PDF and DOCX documents are supported')
    return profile
