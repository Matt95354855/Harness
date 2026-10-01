"""Offline corpus preparation cases; no OCR, model, network or database required."""
import pytest

from mass_classification.corpus import Draft, finalize, inventory, main, write_new
from mass_classification.evaluation import Corpus


def draft_for(tmp_path):
    (tmp_path / 'a.pdf').write_bytes(b'%PDF-1.7\nfixture only')
    return inventory(tmp_path, 'sample', 'fixture', 'internal fixture', True, 1000)


def reviewed(draft):
    raw = draft.model_dump()
    raw.update(rights_confirmed=True, annotation_provenance='human review v1')
    for i, item in enumerate(raw['documents']):
        item.update(document_id=f'api-id-{i}', group_id='family', split='test',
                    labels=['banking'], reviewed=True)
    return Draft.model_validate(raw)


def test_inventory_has_no_invented_annotations(tmp_path):
    draft = draft_for(tmp_path)
    row = draft.documents[0]
    assert row.path == 'a.pdf'
    assert row.labels is row.group_id is row.split is row.document_id is None
    assert row.reviewed is False and draft.rights_confirmed is False


def test_repeatable_inventory(tmp_path):
    first = draft_for(tmp_path)
    assert first == inventory(tmp_path, 'sample', 'fixture', 'internal fixture', True, 1000)


def test_finalize_matches_existing_contract(tmp_path):
    result = finalize(reviewed(draft_for(tmp_path)), tmp_path, 1000)
    assert Corpus.model_validate(result.model_dump()) == result
    assert 'path' not in result.model_dump()['documents'][0]


def test_unreviewed_rejected(tmp_path):
    with pytest.raises(ValueError):
        finalize(draft_for(tmp_path), tmp_path, 1000)


@pytest.mark.parametrize('field,value', [('labels', None), ('reviewed', False),
                         ('document_id', ' '), ('group_id', None), ('split', None)])
def test_missing_annotation_rejected(tmp_path, field, value):
    raw = reviewed(draft_for(tmp_path)).model_dump()
    raw['documents'][0][field] = value
    with pytest.raises(ValueError):
        finalize(Draft.model_validate(raw), tmp_path, 1000)


def test_empty_labels_are_reviewed_out_of_scope(tmp_path):
    raw = reviewed(draft_for(tmp_path)).model_dump()
    raw['documents'][0]['labels'] = []
    assert finalize(Draft.model_validate(raw), tmp_path, 1000).documents[0].labels == []


def test_changed_file_rejected(tmp_path):
    draft = reviewed(draft_for(tmp_path))
    (tmp_path / 'a.pdf').write_bytes(b'%PDF-1.7\nchanged')
    with pytest.raises(ValueError):
        finalize(draft, tmp_path, 1000)


def test_duplicate_content_rejected(tmp_path):
    draft_for(tmp_path)
    (tmp_path / 'b.pdf').write_bytes((tmp_path / 'a.pdf').read_bytes())
    with pytest.raises(ValueError):
        inventory(tmp_path, 'sample', 'fixture', 'fixture', True, 1000)


def test_family_leakage_rejected(tmp_path):
    draft_for(tmp_path)
    (tmp_path / 'b.pdf').write_bytes(b'%PDF-1.7\nsecond')
    raw = reviewed(inventory(tmp_path, 'sample', 'fixture', 'fixture', True, 1000)).model_dump()
    raw['documents'][1]['split'] = 'calibration'
    with pytest.raises(ValueError):
        finalize(Draft.model_validate(raw), tmp_path, 1000)


@pytest.mark.parametrize('path', ['../outside.pdf', '/absolute.pdf', 'x/../a.pdf', 'C:/a.pdf'])
def test_escaping_paths_rejected(tmp_path, path):
    raw = draft_for(tmp_path).model_dump()
    raw['documents'][0]['path'] = path
    with pytest.raises(ValueError):
        Draft.model_validate(raw)


def test_symlink_rejected(tmp_path):
    draft_for(tmp_path)
    (tmp_path / 'link.pdf').symlink_to(tmp_path / 'a.pdf')
    with pytest.raises(ValueError):
        inventory(tmp_path, 'sample', 'fixture', 'fixture', True, 1000)


def test_size_and_signature_rejected(tmp_path):
    draft_for(tmp_path)
    with pytest.raises(ValueError):
        inventory(tmp_path, 'sample', 'fixture', 'fixture', True, 2)
    (tmp_path / 'a.pdf').write_bytes(b'not a pdf')
    with pytest.raises(ValueError):
        inventory(tmp_path, 'sample', 'fixture', 'fixture', True, 1000)


def test_docx_inventory_only_checks_basic_signature(tmp_path):
    # Deliberately not a complete Word archive: parser validation belongs to the service.
    (tmp_path / 'example.DOCX').write_bytes(b'PK\x03\x04fixture')
    result = inventory(tmp_path, 'sample', 'fixture', 'fixture', True, 1000)
    assert result.documents[0].format == 'docx'


@pytest.mark.parametrize('field,value', [('rights_confirmed', False),
                         ('annotation_provenance', ' '), ('rights_reference', ' ')])
def test_unconfirmed_provenance_rejected(tmp_path, field, value):
    raw = reviewed(draft_for(tmp_path)).model_dump()
    raw[field] = value
    with pytest.raises(ValueError):
        finalize(Draft.model_validate(raw), tmp_path, 1000)


def test_unknown_label_rejected(tmp_path):
    raw = reviewed(draft_for(tmp_path)).model_dump()
    raw['documents'][0]['labels'] = ['financial_reports']
    with pytest.raises(ValueError):
        Draft.model_validate(raw)


def test_private_exclusive_output(tmp_path):
    path = tmp_path / 'private.json'
    write_new(path, {'one': 1})
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        write_new(path, {'two': 2})
    assert path.read_bytes() == before
    assert path.stat().st_mode & 0o077 == 0


def test_cli_does_not_echo_private_path(tmp_path, capsys):
    with pytest.raises(SystemExit) as error:
        main(['inventory', '--root', str(tmp_path / 'secret-folder'),
              '--output', str(tmp_path / 'out.json'), '--dataset-id', 'sample',
              '--source-reference', 'fixture', '--rights-reference', 'fixture',
              '--synthetic', 'true'])
    assert error.value.code == 2
    assert 'secret-folder' not in capsys.readouterr().err
