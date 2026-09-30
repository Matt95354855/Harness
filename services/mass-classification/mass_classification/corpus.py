"""Prepare a private, human-reviewed PDF/DOCX corpus without inference or network I/O."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
from typing import Literal

from pydantic import Field, model_validator

from .evaluation import Annotation, Corpus, StrictModel, read_json


class DraftDocument(StrictModel):
    path: str = Field(min_length=1)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    bytes: int = Field(gt=0)
    format: Literal['pdf', 'docx']
    document_id: str | None = None
    group_id: str | None = None
    split: Literal['train', 'calibration', 'test'] | None = None
    labels: list[Literal['banking', 'investigation', 'media']] | None = None
    reviewed: bool = False

    @model_validator(mode='after')
    def safe_path(self):
        path = PurePosixPath(self.path)
        if (path.is_absolute() or '..' in path.parts or '\\' in self.path
                or ':' in self.path or str(path) != self.path or self.path == '.'):
            raise ValueError('path must be a canonical relative POSIX path')
        if path.suffix.lower() != '.' + self.format:
            raise ValueError('format does not match extension')
        if self.labels is not None and len(self.labels) != len(set(self.labels)):
            raise ValueError('duplicate labels')
        return self


class Draft(StrictModel):
    version: Literal['classification-corpus-draft:v1']
    dataset_id: str = Field(min_length=1)
    annotation_provenance: str | None = None
    source_reference: str = Field(min_length=1)
    rights_reference: str = Field(min_length=1)
    rights_confirmed: bool = False
    synthetic: bool
    documents: list[DraftDocument] = Field(min_length=1)

    @model_validator(mode='after')
    def unique_content(self):
        for field in ('path', 'sha256'):
            values = [getattr(item, field) for item in self.documents]
            if len(values) != len(set(values)):
                raise ValueError('duplicate path or content; curate inventory first')
        return self


def bounded_fingerprint(root: Path, relative: str, limit: int):
    """Refuse symlinks and bound reads; signature checks are not parser validation.

    Use a trusted, quiescent local directory. This is not a hostile-filesystem sandbox.
    """
    current = root
    for part in PurePosixPath(relative).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('symbolic links are not accepted')
    path = current.resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError('file must remain inside corpus root')
    with path.open('rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= limit:
            raise ValueError('invalid file size or type')
        digest, size, head = hashlib.sha256(), 0, b''
        while block := stream.read(min(1024 * 1024, limit + 1 - size)):
            if not head:
                head = block[:8]
            size += len(block)
            if size > limit:
                raise ValueError('file exceeds limit')
            digest.update(block)
        after = os.fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or size != before.st_size:
        raise ValueError('file changed during inventory')
    fmt = path.suffix.lower().lstrip('.')
    if fmt not in {'pdf', 'docx'}:
        raise ValueError('unsupported format')
    if not head.startswith(b'%PDF' if fmt == 'pdf' else b'PK\x03\x04'):
        raise ValueError('invalid basic signature')
    return digest.hexdigest(), size, fmt


def inventory(root: Path, dataset_id: str, source_reference: str,
              rights_reference: str, synthetic: bool, max_bytes: int) -> Draft:
    root = root.resolve(strict=True)
    if not root.is_dir() or max_bytes < 1:
        raise ValueError('invalid root or size limit')
    documents = []
    # Fail rather than silently omitting symlinked folders or unreadable subtrees.
    def on_error(error):
        raise error
    for directory, folders, files in os.walk(root, followlinks=False, onerror=on_error):
        folders.sort()
        if any((Path(directory) / name).is_symlink() for name in folders):
            raise ValueError('symbolic directories are not accepted')
        for name in sorted(files):
            path = Path(directory) / name
            if path.suffix.lower() not in {'.pdf', '.docx'}:
                continue
            relative = path.relative_to(root).as_posix()
            sha, size, fmt = bounded_fingerprint(root, relative, max_bytes)
            documents.append(DraftDocument(path=relative, sha256=sha, bytes=size, format=fmt))
    return Draft(version='classification-corpus-draft:v1', dataset_id=dataset_id,
                 source_reference=source_reference, rights_reference=rights_reference,
                 synthetic=synthetic, documents=sorted(documents, key=lambda item: item.path))


def finalize(draft: Draft, root: Path, max_bytes: int) -> Corpus:
    """Require explicit annotations and API IDs; never infer classes or group IDs."""
    if not draft.rights_confirmed or not (draft.annotation_provenance or '').strip():
        raise ValueError('usage rights and annotation provenance must be confirmed')
    if not draft.source_reference.strip() or not draft.rights_reference.strip():
        raise ValueError('source and rights references must be nonblank')
    root = root.resolve(strict=True)
    documents = []
    for item in draft.documents:
        if (not item.reviewed or item.labels is None or item.split is None
                or not (item.document_id or '').strip() or not (item.group_id or '').strip()):
            raise ValueError('all annotations, groups, splits and document IDs are required')
        sha, size, fmt = bounded_fingerprint(root, item.path, max_bytes)
        if (sha, size, fmt) != (item.sha256, item.bytes, item.format):
            raise ValueError('document changed after annotation')
        documents.append(Annotation(document_id=item.document_id, sha256=sha,
                                    group_id=item.group_id, split=item.split,
                                    format=fmt, labels=sorted(item.labels)))
    return Corpus(version='classification-corpus:v1', dataset_id=draft.dataset_id,
                  annotation_provenance=draft.annotation_provenance,
                  synthetic=draft.synthetic,
                  documents=sorted(documents, key=lambda item: item.document_id))


def write_new(path: Path, value: dict):
    # Mode 0600 on POSIX; exclusive creation never overwrites inputs or prior output.
    payload = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        stream.write(payload)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('inventory', 'finalize'):
        command = commands.add_parser(name)
        command.add_argument('--root', type=Path, required=True)
        command.add_argument('--output', type=Path, required=True)
        command.add_argument('--max-bytes', type=int, default=52_428_800)
        if name == 'inventory':
            command.add_argument('--dataset-id', required=True)
            command.add_argument('--source-reference', required=True)
            command.add_argument('--rights-reference', required=True)
            command.add_argument('--synthetic', choices=('true', 'false'), required=True)
        else:
            command.add_argument('--draft', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.max_bytes < 1:
            raise ValueError('invalid size limit')
        if args.command == 'inventory':
            result = inventory(args.root, args.dataset_id, args.source_reference,
                               args.rights_reference, args.synthetic == 'true', args.max_bytes)
        else:
            raw, _ = read_json(args.draft)
            result = finalize(Draft.model_validate(raw), args.root, args.max_bytes)
        write_new(args.output, result.model_dump())
    except (ValueError, OSError, RuntimeError) as exc:
        # Validation errors may include private labels, paths and provenance.
        parser.exit(2, f'Corpus preparation rejected ({type(exc).__name__}); '
                    'check input schema, annotations, rights, file integrity and output path.\n')
    print(f'Prepared {len(result.documents)} documents; no inference or model approval performed.')


if __name__ == '__main__':
    main()
