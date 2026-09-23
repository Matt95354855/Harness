"""Offline tenant-specific fine tuning from curated sentence pairs."""
import argparse
import csv
from pathlib import Path
import random


def main():
    from sentence_transformers import SentenceTransformer, InputExample, losses
    from torch.utils.data import DataLoader
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", required=True, help="UTF-8 TSV: text_a, text_b, similarity in [0,1]")
    p.add_argument("--base-model", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--epochs", type=int, default=1)
    args = p.parse_args()
    with open(args.pairs, encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream, delimiter="\t"))
    if len(rows) < 100:
        raise SystemExit("At least 100 reviewed pairs required")
    pairs = [InputExample(texts=[row["text_a"], row["text_b"]], label=float(row["similarity"])) for row in rows]
    if any(not 0 <= item.label <= 1 for item in pairs):
        raise SystemExit("Similarity labels must be in [0,1]")
    random.Random(42).shuffle(pairs)
    split = int(len(pairs) * .8)
    model = SentenceTransformer(args.base_model)
    loss = losses.CosineSimilarityLoss(model)
    model.fit(train_objectives=[(DataLoader(pairs[:split], shuffle=True, batch_size=16), loss)],
              epochs=args.epochs, show_progress_bar=True)
    from sentence_transformers.evaluation import EmbeddingSimilarityEvaluator
    evaluator = EmbeddingSimilarityEvaluator([x.texts[0] for x in pairs[split:]],
                                             [x.texts[1] for x in pairs[split:]],
                                             [x.label for x in pairs[split:]])
    score = evaluator(model)
    if model.get_sentence_embedding_dimension() != 384:
        raise SystemExit("Fine-tuned model must remain 384-dimensional")
    model.save(args.output)
    print(f"held_out_spearman={score:.4f} holdout_pairs={len(pairs)-split}")


if __name__ == "__main__":
    main()
