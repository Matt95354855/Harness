"""Bounded simplicial topology and interpretable graph statistics."""
import networkx as nx
import numpy as np


def graph_metrics(edges: list[tuple[str, str]], max_nodes: int = 1000) -> dict:
    graph = nx.Graph()
    graph.add_edges_from(edges)
    if len(graph) > max_nodes:
        raise ValueError("Subgraph exceeds node limit; sample a case-specific neighborhood")
    if not graph:
        return {"nodes": 0, "edges": 0, "components": 0, "triangles": 0, "betti_0": 0, "betti_1_graph": 0}
    components = nx.number_connected_components(graph)
    return {
        "nodes": len(graph), "edges": graph.number_of_edges(), "components": components,
        "triangles": sum(nx.triangles(graph).values()) // 3,
        "betti_0": components, "betti_1_graph": graph.number_of_edges() - len(graph) + components,
        "density": round(nx.density(graph), 4),
        "degree_centrality": sorted(nx.degree_centrality(graph).items(), key=lambda item: -item[1])[:10],
    }


def simplices(edges: list[tuple[str, str]], max_nodes: int = 500, max_triangles: int = 5000):
    graph = nx.Graph()
    graph.add_edges_from(edges)
    if len(graph) > max_nodes:
        raise ValueError("Topology node limit exceeded")
    triangles = []
    for clique in nx.enumerate_all_cliques(graph):
        if len(clique) == 3:
            triangles.append(tuple(sorted(clique)))
            if len(triangles) > max_triangles:
                raise ValueError("Topology triangle limit exceeded")
        if len(clique) > 3:
            break
    return sorted(graph.nodes), sorted(tuple(sorted(e)) for e in graph.edges), triangles


def incidence(edges: list[tuple[str, str]]):
    nodes, links, triangles = simplices(edges)
    index = {node: i for i, node in enumerate(nodes)}
    edge_index = {edge: i for i, edge in enumerate(links)}
    b1 = np.zeros((len(nodes), len(links)), dtype=np.float32)
    b2 = np.zeros((len(links), len(triangles)), dtype=np.float32)
    for j, (a, b) in enumerate(links):
        b1[index[a], j], b1[index[b], j] = -1, 1
    for j, (a, b, c) in enumerate(triangles):
        b2[edge_index[(a, b)], j] = 1
        b2[edge_index[(a, c)], j] = -1
        b2[edge_index[(b, c)], j] = 1
    assert np.allclose(b1 @ b2, 0), "Invalid simplicial boundary"
    return nodes, links, triangles, b1, b2


def persistent_homology(edges: list[tuple[str, str]], weights: dict[tuple[str, str], float] | None = None) -> dict:
    """Clique filtration on a bounded subgraph. Edge dissimilarities in [0,1]."""
    import gudhi
    nodes, links, triangles = simplices(edges)
    complex_ = gudhi.SimplexTree()
    ids = {name: idx for idx, name in enumerate(nodes)}
    for node in nodes:
        complex_.insert([ids[node]], filtration=0.0)
    for a, b in links:
        weight = (weights or {}).get((a, b), 1.0)
        if not 0 <= weight <= 1:
            raise ValueError("Filtration weights must be in [0,1]")
        complex_.insert([ids[a], ids[b]], filtration=weight)
    for a, b, c in triangles:
        complex_.insert([ids[a], ids[b], ids[c]], filtration=max(complex_.filtration([ids[a],ids[b]]), complex_.filtration([ids[a],ids[c]]), complex_.filtration([ids[b],ids[c]])))
    diagram = complex_.persistence()
    return {"betti": complex_.betti_numbers(),
            "intervals": [{"dimension": dimension, "birth": birth,
                           "death": None if death == float("inf") else death}
                          for dimension, (birth, death) in diagram[:200]],
            "simplices": complex_.num_simplices()}
