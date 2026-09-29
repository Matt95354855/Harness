"""Offline supervised training from reviewed graph snapshots (.npz); never train on predictions."""
import argparse
import json
from pathlib import Path
import random

import numpy as np


def main():
    import torch
    from .tnn import TopologicalNetwork, aggregate
    p = argparse.ArgumentParser()
    p.add_argument("--dataset", required=True, help="NPZ with samples: graph dicts with nodes, b1, b2, label, risk")
    p.add_argument("--output", required=True)
    p.add_argument("--classes", nargs="+", required=True)
    p.add_argument("--epochs", type=int, default=20)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    with np.load(args.dataset, allow_pickle=True) as data:
        samples = list(data["samples"])
    if len(samples) < 20:
        raise SystemExit("At least 20 human labeled case graphs required")
    order = np.random.permutation(len(samples))
    split = int(len(order) * 0.8)
    train, valid = order[:split], order[split:]
    network = TopologicalNetwork(num_classes=len(args.classes))
    optimizer = torch.optim.AdamW(network.parameters(), lr=0.0005)

    def forward(item):
        nodes = torch.as_tensor(item["nodes"], dtype=torch.float32)
        b1 = torch.as_tensor(item["b1"], dtype=torch.float32)
        b2 = torch.as_tensor(item["b2"], dtype=torch.float32)
        edges = aggregate(b1.T, nodes)
        faces = aggregate(b2.T, edges)
        return network(nodes, edges, faces, b1, b2)

    for epoch in range(args.epochs):
        network.train()
        for idx in train:
            item = samples[idx].item() if hasattr(samples[idx], "item") else samples[idx]
            optimizer.zero_grad()
            output = forward(item)
            loss = torch.nn.functional.cross_entropy(output["logits"][None], torch.tensor([int(item["label"])]))
            loss += torch.nn.functional.binary_cross_entropy(output["risk"], torch.tensor(float(item["risk"])))
            loss.backward(); optimizer.step()
        network.eval(); correct = 0
        with torch.inference_mode():
            for idx in valid:
                item = samples[idx].item() if hasattr(samples[idx], "item") else samples[idx]
                correct += int(forward(item)["logits"].argmax().item() == int(item["label"]))
        print(f"epoch={epoch+1} validation_accuracy={correct / len(valid):.3f}")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(network.state_dict(), output)
    output.with_suffix(".json").write_text(json.dumps({"classes": args.classes, "version": output.stem,
        "validation_accuracy": correct / len(valid), "validation_size": len(valid), "seed": args.seed}, indent=2))


if __name__ == "__main__":
    main()
