"""Simplicial message passing with trained classification and risk heads."""
from pathlib import Path

import torch
from torch import nn
import torch.nn.functional as F


def aggregate(incidence: torch.Tensor, features: torch.Tensor) -> torch.Tensor:
    """Mean of incident cells; supports empty dimensions and variable graph sizes."""
    weights = incidence.abs()
    return weights @ features / weights.sum(dim=1, keepdim=True).clamp_min(1)


class SimplicialLayer(nn.Module):
    def __init__(self, hidden: int):
        super().__init__()
        self.nodes = nn.Linear(hidden * 2, hidden)
        self.edges = nn.Linear(hidden * 3, hidden)
        self.faces = nn.Linear(hidden * 2, hidden)
        self.norm_node = nn.LayerNorm(hidden)
        self.norm_edge = nn.LayerNorm(hidden)

    def forward(self, nodes, edges, faces, b1, b2):
        node_update = F.gelu(self.nodes(torch.cat((nodes, aggregate(b1, edges)), dim=-1)))
        edge_update = F.gelu(self.edges(torch.cat((edges, aggregate(b1.T, nodes), aggregate(b2, faces)), dim=-1)))
        face_update = F.gelu(self.faces(torch.cat((faces, aggregate(b2.T, edges)), dim=-1)))
        return self.norm_node(nodes + node_update), self.norm_edge(edges + edge_update), faces + face_update


class TopologicalNetwork(nn.Module):
    def __init__(self, input_dim: int = 384, hidden: int = 128, num_classes: int = 3):
        super().__init__()
        self.node_in = nn.Linear(input_dim, hidden)
        self.edge_in = nn.Linear(input_dim, hidden)
        self.face_in = nn.Linear(input_dim, hidden)
        self.layers = nn.ModuleList([SimplicialLayer(hidden) for _ in range(2)])
        self.self_attention = nn.MultiheadAttention(hidden, num_heads=4, batch_first=True)
        self.attention = nn.Linear(hidden, 1)
        self.classifier = nn.Linear(hidden, num_classes)
        self.risk = nn.Linear(hidden, 1)

    def forward(self, node_features, edge_features, face_features, b1, b2):
        if node_features.shape[0] == 0:
            raise ValueError("Graph needs at least one node")
        nodes = self.node_in(node_features)
        edges = self.edge_in(edge_features)
        faces = self.face_in(face_features)
        for layer in self.layers:
            nodes, edges, faces = layer(nodes, edges, faces, b1, b2)
        refined, _ = self.self_attention(nodes.unsqueeze(0), nodes.unsqueeze(0), nodes.unsqueeze(0), need_weights=False)
        nodes = nodes + refined.squeeze(0)
        attention = torch.softmax(self.attention(nodes).squeeze(-1), dim=0)
        pooled = (attention[:, None] * nodes).sum(dim=0)
        return {"logits": self.classifier(pooled), "risk": torch.sigmoid(self.risk(pooled)).squeeze(-1),
                "attention": attention}


def predict(checkpoint: Path, features, b1, b2) -> dict:
    """Only load a local operator-approved checkpoint; no untrusted uploads."""
    import json
    import numpy as np
    metadata = json.loads(checkpoint.with_suffix(".json").read_text())
    from .config import settings
    device = settings().device
    if device not in {"cpu", "cuda"} or (device == "cuda" and not torch.cuda.is_available()):
        raise RuntimeError("Configured inference device unavailable")
    network = TopologicalNetwork(num_classes=len(metadata["classes"]))
    network.load_state_dict(torch.load(checkpoint, map_location="cpu", weights_only=True))
    network.to(device).eval()
    with torch.inference_mode():
        node = torch.as_tensor(np.asarray(features, dtype=np.float32), device=device)
        incidence1 = torch.as_tensor(b1, device=device)
        incidence2 = torch.as_tensor(b2, device=device)
        edge = aggregate(incidence1.T, node)
        face = aggregate(incidence2.T, edge)
        output = network(node, edge, face, incidence1, incidence2)
        return {"classes": dict(zip(metadata["classes"], torch.softmax(output["logits"], 0).tolist())),
                "risk_score": float(output["risk"]), "attention": output["attention"].tolist(),
                "model_version": metadata["version"]}
